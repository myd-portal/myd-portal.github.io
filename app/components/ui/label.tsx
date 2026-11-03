import { forwardRef, type LabelHTMLAttributes } from "react";

export type LabelProps = LabelHTMLAttributes<HTMLLabelElement>;

export const Label = forwardRef<HTMLLabelElement, LabelProps>(function Label({ className = "", ...props }, ref) {
  return <label ref={ref} className={`ui-label ${className}`.trim()} {...props} />;
});

Label.displayName = "Label";
