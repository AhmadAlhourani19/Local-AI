import React, {useRef} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';

function repairMarkdown(src = '') {
  let s = (src || '').replace(/\r/g, '');

  const ticks = (s.match(/```/g) || []).length;
  if (ticks % 2 === 1) s += '\n```';

  const dbl = (s.match(/\$\$/g) || []).length;
  if (dbl % 2 === 1) s += '\n$$';

  return s;
}

function CodeBlock({inline, className, children, ...props}) {
  const ref = useRef(null);
  if (inline) {
    return <code className={className} {...props}>{children}</code>;
  }
  const onCopy = async () => {
    const text = String(children || '').replace(/\n+$/, '');
    try { await navigator.clipboard.writeText(text); } catch {}
  };
  return (
    <div className="md-codewrap">
      <pre ref={ref}><code className={className} {...props}>{children}</code></pre>
      <button className="md-copybtn" onClick={onCopy} title="Code kopieren">kopieren</button>
    </div>
  );
}

function FigureImage({alt, src, title}) {
  return (
    <figure className="md-figure">
      <img src={src} alt={alt || 'image'} loading="lazy" />
      {(alt || title) ? <figcaption>{title || alt}</figcaption> : null}
    </figure>
  );
}

export default function MarkdownMessage({text}) {
  const content = repairMarkdown(text);

  return (
    <div className="md-root">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex, rehypeHighlight]}
        components={{
          code: CodeBlock,
          img: ({node, ...props}) => <FigureImage {...props} />,
          table: ({node, ...props}) => <table className="md-table" {...props} />,
          th: ({node, ...props}) => <th className="md-th" {...props} />,
          td: ({node, ...props}) => <td className="md-td" {...props} />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
