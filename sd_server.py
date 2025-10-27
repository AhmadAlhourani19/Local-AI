# sd_server.py — Stable Diffusion XL FastAPI server (RTX-50 / Blackwell optimized)
# Fix: proper SDXL Base → Refiner *latent* hand-off + guidance_rescale support.
# Default: 40 steps for more detail.

import os
import time
import asyncio
import io
import base64
from typing import Optional, Tuple
from contextlib import contextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field
from PIL import Image

import torch
from diffusers import (
    StableDiffusionXLPipeline,
    StableDiffusionXLImg2ImgPipeline,
    DPMSolverMultistepScheduler,
)

# ----- Model locations -----
SDXL_DIR = os.getenv("SDXL_DIR", r"C:\LLM\stable-diffusion-xl-base-1.0")
SDXL_REFINER_DIR = os.getenv("SDXL_REFINER_DIR", r"C:\LLM\stable-diffusion-xl-refiner-1.0")

# ----- Limits / Defaults -----
MAX_W = 1024
MAX_H = 1024
MAX_STEPS = 60
DEFAULT_STEPS = 60
DEFAULT_GUIDANCE = 9.5        # strong adherence by default

# Toggle compile via env var (off by default to avoid Triton requirement on fresh installs)
ENABLE_TORCH_COMPILE = os.getenv("SD_TORCH_COMPILE", "0") == "1"

app = FastAPI(title="Local SDXL Server (40-step detailed)")

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global state
pipe: Optional[StableDiffusionXLPipeline] = None
refiner: Optional[StableDiffusionXLImg2ImgPipeline] = None
_model_ready = asyncio.Event()
_model_error: Optional[str] = None
_current_device = "cpu"
_current_dtype = "float32"
_has_refiner = False


def _check_layout(path: str):
    must = [
        os.path.join(path, "model_index.json"),
        os.path.join(path, "unet", "diffusion_pytorch_model.safetensors"),
        os.path.join(path, "vae", "diffusion_pytorch_model.safetensors"),
    ]
    missing = [p for p in must if not os.path.isfile(p)]
    if missing:
        raise RuntimeError("Missing required files:\n" + "\n".join(missing))


def _choose_device_dtype() -> Tuple[str, torch.dtype]:
    """Prefer CUDA + bfloat16 (Blackwell/RTX 50); else CPU + float32."""
    use_cuda = torch.cuda.is_available()
    device = "cuda" if use_cuda else "cpu"
    dtype = torch.bfloat16 if use_cuda else torch.float32
    return device, dtype


def _apply_good_scheduler(p):
    """Fast & detailed scheduler (DPM++ 2M style with Karras sigmas)."""
    try:
        p.scheduler = DPMSolverMultistepScheduler.from_config(
            p.scheduler.config, use_karras_sigmas=True
        )
    except Exception as e:
        print("[SDXL] Scheduler swap skipped:", e)


def _build_pipeline_base(model_dir: str, device: str, dtype: torch.dtype) -> StableDiffusionXLPipeline:
    print(f"[SDXL] Building BASE pipeline: device={device}, dtype={dtype}")
    p = StableDiffusionXLPipeline.from_pretrained(
        model_dir,
        torch_dtype=dtype,
        use_safetensors=True,
        variant="fp16",  # many repos tag reduced precision as "fp16"; fine to run in bf16
    ).to(device)

    # Prefer PyTorch SDPA over legacy attention slicing/xFormers
    try:
        p.enable_xformers_memory_efficient_attention(False)
    except Exception:
        pass

    _apply_good_scheduler(p)
    return p


def _build_pipeline_refiner(model_dir: str, device: str, dtype: torch.dtype) -> StableDiffusionXLImg2ImgPipeline:
    print(f"[SDXL] Building REFINER pipeline: device={device}, dtype={dtype}")
    rp = StableDiffusionXLImg2ImgPipeline.from_pretrained(
        model_dir,
        torch_dtype=dtype,
        use_safetensors=True,
        variant="fp16",
    ).to(device)

    try:
        rp.enable_xformers_memory_efficient_attention(False)
    except Exception:
        pass

    _apply_good_scheduler(rp)
    return rp


def _has_triton() -> bool:
    try:
        import triton  # noqa: F401
        return True
    except Exception:
        return False


async def _load_model_bg():
    """Load the SDXL pipelines in the background on server startup."""
    global pipe, refiner, _model_error, _current_device, _current_dtype, _has_refiner
    try:
        t0 = time.time()
        print(f"[SDXL] Using SDXL_DIR: {SDXL_DIR}")
        _check_layout(SDXL_DIR)

        device, dtype = _choose_device_dtype()

        # Diagnostics
        use_cuda = (device == "cuda")
        try:
            gpu_name = torch.cuda.get_device_name(0) if use_cuda else "-"
        except Exception:
            gpu_name = "-"
        try:
            cap = torch.cuda.get_device_capability(0) if use_cuda else "-"
        except Exception:
            cap = "-"
        print(
            f"[SDXL] torch={torch.__version__}, cuda={getattr(torch.version, 'cuda', None)}, "
            f"gpu_ok={use_cuda}, name={gpu_name}, cap={cap}, device={device}, dtype={dtype}"
        )

        # Perf toggles
        if device == "cuda":
            torch.backends.cudnn.benchmark = True
            torch.set_float32_matmul_precision("high")  # TF32 on leftover fp32

        # Base pipeline
        pipe = _build_pipeline_base(SDXL_DIR, device, dtype)
        _current_device = device
        _current_dtype = "bfloat16" if dtype == torch.bfloat16 else "float32"

        # Refiner (optional)
        _has_refiner = False
        try:
            if os.path.isdir(SDXL_REFINER_DIR):
                _check_layout(SDXL_REFINER_DIR)
                refiner = _build_pipeline_refiner(SDXL_REFINER_DIR, device, dtype)
                _has_refiner = True
                print("[SDXL] Refiner loaded and ready.")
            else:
                print(f"[SDXL] No refiner directory found at: {SDXL_REFINER_DIR} (skipping)")
        except Exception as e:
            print("[SDXL] Refiner load skipped due to error:", e)
            refiner = None
            _has_refiner = False

        # Optional: compile (requires Triton)
        if device == "cuda" and ENABLE_TORCH_COMPILE and _has_triton():
            try:
                pipe.unet = torch.compile(pipe.unet, mode="max-autotune")
                print("[SDXL] torch.compile enabled for BASE.")
            except Exception as _e:
                print("[SDXL] torch.compile (BASE) skipped:", _e)
            if refiner is not None:
                try:
                    refiner.unet = torch.compile(refiner.unet, mode="max-autotune")
                    print("[SDXL] torch.compile enabled for REFINER.")
                except Exception as _e:
                    print("[SDXL] torch.compile (REFINER) skipped:", _e)
        elif ENABLE_TORCH_COMPILE and not _has_triton():
            print("[SDXL] torch.compile disabled: Triton not installed.")

        _model_error = None
        _model_ready.set()
        print(f"[SDXL] Models loaded in {time.time() - t0:.1f}s on {device} | refiner={_has_refiner}")
    except Exception as e:
        _model_error = str(e)
        print("[SDXL] Failed to load model(s):", _model_error)
        _model_ready.clear()


@app.on_event("startup")
async def _startup():
    asyncio.create_task(_load_model_bg())


class Txt2ImgReq(BaseModel):
    prompt: str = Field(..., description="Positive prompt")
    negative_prompt: Optional[str] = Field(
        default="low quality, watermark, text, extra fingers, wrong anatomy, blurry",
        description="Negative prompt",
    )
    width: int = Field(default=832, ge=256, le=MAX_W)
    height: int = Field(default=1216, ge=256, le=MAX_H)

    steps: int = Field(default=DEFAULT_STEPS, ge=5, le=MAX_STEPS)  # default = 40
    guidance: float = Field(default=DEFAULT_GUIDANCE, ge=0.0, le=40.0)
    guidance_rescale: float = Field(default=0.75, ge=0.0, le=1.0)
    seed: Optional[int] = Field(default=42, description="Random seed (optional)")
    use_refiner: bool = Field(default=True, description="Use SDXL refiner when available")
    refiner_fraction: float = Field(
        default=0.8, ge=0.5, le=0.98,
        description="Fraction of denoising done by BASE before handing off to REFINER"
    )


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/favicon.ico")
def favicon():
    return Response(content=b"", media_type="image/x-icon", headers={"Cache-Control": "max-age=3600"})


@app.get("/status")
def status():
    return {
        "ready": _model_ready.is_set(),
        "error": _model_error,
        "cuda": torch.cuda.is_available(),
        "torch": torch.__version__,
        "model_dir": SDXL_DIR,
        "refiner_dir": SDXL_REFINER_DIR if _has_refiner else None,
        "device": _current_device,
        "dtype": _current_dtype,
        "has_refiner": _has_refiner,
        "default_steps": DEFAULT_STEPS,
    }


@contextmanager
def _sdp_flash():
    # Force Flash/MemEff SDPA kernels where possible
    with torch.backends.cuda.sdp_kernel(enable_flash=True, enable_mem_efficient=True, enable_math=False):
        yield


@app.post("/txt2img")
def txt2img(p: Txt2ImgReq):
    global pipe, refiner, _current_device, _current_dtype, _has_refiner

    if _model_error:
        raise HTTPException(500, f"Model failed to load: {_model_error}")
    if not _model_ready.is_set():
        raise HTTPException(503, "Model is still loading; try again shortly.")

    if p.width > MAX_W or p.height > MAX_H:
        raise HTTPException(400, f"Max size is {MAX_W}x{MAX_H}")
    if p.steps > MAX_STEPS:
        raise HTTPException(400, f"Max steps is {MAX_STEPS}")
    if not (0.0 < p.refiner_fraction < 1.0):
        raise HTTPException(400, "refiner_fraction must be in (0,1)")

    use_cuda = torch.cuda.is_available() and (_current_device == "cuda")
    dev = "cuda" if use_cuda else "cpu"

    gen = torch.Generator(device=dev)
    if p.seed is not None:
        gen = gen.manual_seed(int(p.seed))

    # ---- BASE kwargs (common) ----
    base_kwargs = dict(
        prompt=p.prompt,
        negative_prompt=p.negative_prompt,
        width=p.width,
        height=p.height,
        num_inference_steps=p.steps,
        guidance_scale=p.guidance,
        guidance_rescale=p.guidance_rescale,
        generator=gen,
    )

    use_ref = _has_refiner and p.use_refiner

    # If using refiner: BASE returns LATENTS, then REFINER continues from that point.
    if use_ref:
        base_kwargs["denoising_end"] = p.refiner_fraction
        base_kwargs["output_type"] = "latent"

        ref_kwargs = dict(
            prompt=p.prompt,
            negative_prompt=p.negative_prompt,
            image=None,  # will be latents tensor from base
            num_inference_steps=p.steps,
            guidance_scale=p.guidance,
            guidance_rescale=p.guidance_rescale,
            denoising_start=p.refiner_fraction,
            generator=gen,
        )
    else:
        ref_kwargs = None  # base will directly produce PIL

    t0 = time.time()

    def run_cuda_base(**kwargs):
        with torch.autocast(device_type="cuda", dtype=torch.bfloat16):
            with _sdp_flash():
                return pipe(**kwargs)

    def run_cuda_refine(latents):
        assert refiner is not None
        with torch.autocast(device_type="cuda", dtype=torch.bfloat16):
            with _sdp_flash():
                ref_kwargs["image"] = latents
                return refiner(**ref_kwargs)

    def run_cpu_base(**kwargs):
        return pipe(**kwargs)

    def run_cpu_refine(latents):
        assert refiner is not None
        ref_kwargs["image"] = latents
        return refiner(**ref_kwargs)

    try:
        if use_cuda:
            base_out = run_cuda_base(**base_kwargs)
        else:
            base_out = run_cpu_base(**base_kwargs)

        if use_ref:
            # IMPORTANT: pass LATENTS to refiner
            latents = base_out.images[0]
            refined = run_cuda_refine(latents) if use_cuda else run_cpu_refine(latents)
            final_img: Image.Image = refined.images[0]
        else:
            # Not using refiner → decode to image with a second call
            # (same settings but let it finish & output PIL)
            full_kwargs = dict(base_kwargs)
            full_kwargs.pop("denoising_end", None)
            full_kwargs.pop("output_type", None)
            full_kwargs["output_type"] = "pil"
            full = run_cuda_base(**full_kwargs) if use_cuda else run_cpu_base(**full_kwargs)
            final_img: Image.Image = full.images[0]

    except RuntimeError as e:
        msg = str(e).lower()
        if "no kernel image is available" in msg and use_cuda:
            # Fallback: rebuild on CPU fp32 and try once more
            print("[SDXL] CUDA kernel not available — rebuilding pipeline(s) on CPU fp32 and retrying once.")
            device, dtype = "cpu", torch.float32
            try:
                _ = _check_layout(SDXL_DIR)
                pipe = _build_pipeline_base(SDXL_DIR, device, dtype)
            except Exception as ee:
                raise HTTPException(500, f"Failed to rebuild base pipeline on CPU: {ee}")
            if _has_refiner:
                try:
                    _ = _check_layout(SDXL_REFINER_DIR)
                    refiner = _build_pipeline_refiner(SDXL_REFINER_DIR, device, dtype)
                except Exception as ee:
                    print("[SDXL] Refiner CPU rebuild failed:", ee)
                    refiner = None
                    _has_refiner = False

            _current_device, _current_dtype = "cpu", "float32"

            base_out = run_cpu_base(**base_kwargs)
            if use_ref and refiner is not None:
                latents = base_out.images[0]
                refined = run_cpu_refine(latents)
                final_img = refined.images[0]
            else:
                full_kwargs = dict(base_kwargs)
                full_kwargs.pop("denoising_end", None)
                full_kwargs.pop("output_type", None)
                full_kwargs["output_type"] = "pil"
                full = run_cpu_base(**full_kwargs)
                final_img = full.images[0]
        else:
            raise

    # ---- Encode PNG to base64 ----
    buf = io.BytesIO()
    final_img.save(buf, "PNG")
    b64 = base64.b64encode(buf.getvalue()).decode("utf-8")

    elapsed = time.time() - t0
    print(
        f"[SDXL] Generated in {elapsed:.1f}s | "
        f"{p.width}x{p.height} | steps={p.steps} | cfg={p.guidance} | rescale={p.guidance_rescale} | seed={p.seed} | "
        f"refiner={'on' if use_ref else 'off'}({p.refiner_fraction if use_ref else '-'}) | "
        f"dev={_current_device}/{_current_dtype} | prompt='{p.prompt[:80]}'"
    )
    return {"image_base64": b64}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=9100)