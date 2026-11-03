import { forwardRef, type HTMLAttributes } from "react";

export type CardProps = HTMLAttributes<HTMLDivElement>;

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card({ className = "", ...props }, ref) {
  return <div ref={ref} className={`ui-card ${className}`.trim()} {...props} />;
});

export function CardHeader({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`ui-card-header ${className}`.trim()} {...props} />;
}

export function CardTitle({ className = "", ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={`ui-card-title ${className}`.trim()} {...props} />;
}

export function CardDescription({ className = "", ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={`ui-card-description ${className}`.trim()} {...props} />;
}

export function CardContent({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`ui-card-content ${className}`.trim()} {...props} />;
}

export function CardFooter({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`ui-card-footer ${className}`.trim()} {...props} />;
}

Card.displayName = "Card";
