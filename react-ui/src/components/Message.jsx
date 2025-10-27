import React from 'react';
import MarkdownMessage from './MarkdownMessage.jsx';

export default function Message({ role, content, onCopy }) {
  const copy = () => navigator.clipboard.writeText((content || '').trim());
  return (
    <div className="message">
      <span className="role">{role}:</span>
      <div className="content md">
        <MarkdownMessage text={content || ''} />
      </div>
      <span className="copy" onClick={onCopy || copy}>kopieren</span>
    </div>
  );
}