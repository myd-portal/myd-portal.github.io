import { forwardRef, type ButtonHTMLAttributes } from "react";

export type ButtonVariant = "default" | "destructive" | "outline" | "secondary" | "ghost" | "link";
export type ButtonSize = "default" | "sm" | "lg" | "icon";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className = "", size = "default", variant = "default", ...props },
  ref,
) {
  return <button ref={ref} className={`ui-button ui-button-${variant} ui-button-${size} ${className}`.trim()} {...props} />;
});

Button.displayName = "Button";
