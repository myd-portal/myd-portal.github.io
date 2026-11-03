import { forwardRef, type TextareaHTMLAttributes } from "react";

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({ className = "", ...props }, ref) {
  return <textarea ref={ref} className={`ui-textarea ${className}`.trim()} {...props} />;
});

Textarea.displayName = "Textarea";
