import { forwardRef, type InputHTMLAttributes } from "react";

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ className = "", ...props }, ref) {
  return <input ref={ref} className={`ui-input ${className}`.trim()} {...props} />;
});

Input.displayName = "Input";
