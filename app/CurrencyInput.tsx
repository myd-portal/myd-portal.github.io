"use client";

import { useRef, type InputHTMLAttributes } from "react";
import { formatCurrencyInput } from "@/lib/currency";

type CurrencyInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "inputMode" | "value" | "onChange"> & {
  value: string;
  onValueChange: (value: string) => void;
};

export default function CurrencyInput({ value, onValueChange, onBlur, ...inputProps }: CurrencyInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  return <input
    {...inputProps}
    ref={inputRef}
    type="text"
    inputMode="decimal"
    value={formatCurrencyInput(value)}
    onChange={(event) => {
      const rawValue = event.currentTarget.value;
      const selection = event.currentTarget.selectionStart ?? rawValue.length;
      const nextValue = formatCurrencyInput(rawValue);
      const nextCursor = formatCurrencyInput(rawValue.slice(0, selection)).length;
      onValueChange(nextValue);
      requestAnimationFrame(() => {
        if (inputRef.current && inputRef.current.ownerDocument.activeElement === inputRef.current) {
          inputRef.current.setSelectionRange(Math.min(nextCursor, nextValue.length), Math.min(nextCursor, nextValue.length));
        }
      });
    }}
    onBlur={(event) => {
      onValueChange(formatCurrencyInput(event.currentTarget.value, true));
      onBlur?.(event);
    }}
  />;
}
