import { forwardRef, type HTMLAttributes } from "react";

export type BadgeVariant = "default" | "secondary" | "destructive" | "outline";
export type BadgeProps = HTMLAttributes<HTMLSpanElement> & { variant?: BadgeVariant };

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge({ className = "", variant = "default", ...props }, ref) {
  return <span ref={ref} className={`ui-badge ui-badge-${variant} ${className}`.trim()} {...props} />;
});

Badge.displayName = "Badge";
