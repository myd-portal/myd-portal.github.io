"use client";

import { useId, useState } from "react";

type PasswordInputProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: "current-password" | "new-password";
  placeholder?: string;
  minLength?: number;
  required?: boolean;
  disabled?: boolean;
};

const strengthLabels = ["Very Weak", "Weak", "So-so", "Good", "Strong"] as const;

function passwordStrength(password: string) {
  if (password.length < 6) return 0;

  let score = 0;
  if (password.length >= 8) score += 1;
  if (password.length >= 12) score += 1;
  if (password.length >= 16) score += 1;

  const characterGroups = [/[a-z]/.test(password), /[A-Z]/.test(password), /\d/.test(password), /[^a-zA-Z\d]/.test(password)].filter(Boolean).length;
  if (characterGroups >= 2) score += 1;
  if (characterGroups >= 3) score += 1;

  return Math.min(score, 4);
}

export default function PasswordInput({
  label,
  value,
  onChange,
  autoComplete,
  placeholder,
  minLength,
  required,
  disabled,
}: PasswordInputProps) {
  const inputId = useId();
  const strengthId = useId();
  const [visible, setVisible] = useState(false);
  const strength = passwordStrength(value);
  const strengthLabel = strengthLabels[strength];

  return (
    <div className="password-input-component" data-strength={value ? strength : undefined}>
      <label htmlFor={inputId}>{label}</label>
      <div className="password-input-control">
        <input
          id={inputId}
          type={visible ? "text" : "password"}
          autoComplete={autoComplete}
          minLength={minLength}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          required={required}
          disabled={disabled}
          aria-describedby={value ? strengthId : undefined}
        />
        <button
          type="button"
          className="password-visibility-toggle"
          aria-label={`${visible ? "Hide" : "Show"} ${label.toLowerCase()}`}
          aria-pressed={visible}
          onClick={() => setVisible((current) => !current)}
          disabled={disabled}
        >
          {visible ? (
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 3l18 18" />
              <path d="M10.6 10.6a2 2 0 002.8 2.8" />
              <path d="M9.9 5.2A10.8 10.8 0 0112 5c5 0 8.5 4.1 9.5 7-.4 1.2-1.2 2.4-2.2 3.4" />
              <path d="M6.2 6.2C4.3 7.5 3 9.4 2.5 12c1 2.9 4.5 7 9.5 7 1.2 0 2.3-.2 3.3-.7" />
            </svg>
          ) : (
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2.5 12s3.5-7 9.5-7 9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          )}
        </button>
      </div>
      {value && (
        <div className="password-strength" id={strengthId}>
          <div
            className="password-strength-bars"
            role="meter"
            aria-label={`${label} strength`}
            aria-valuemin={0}
            aria-valuemax={4}
            aria-valuenow={strength}
            aria-valuetext={strengthLabel}
            data-level={strength}
          >
            {Array.from({ length: 4 }, (_, index) => <span key={index} />)}
          </div>
          <div className="password-strength-caption">
            <span data-level={strength}>{strengthLabel}</span>
            <span className="password-strength-info" title="Use a longer password with a mix of letters, numbers, and symbols." aria-label="Use a longer password with a mix of letters, numbers, and symbols.">i</span>
          </div>
        </div>
      )}
    </div>
  );
}
