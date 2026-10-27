"use client";

import { Children, isValidElement, useEffect, useId, useRef, useState, type FocusEvent, type InputHTMLAttributes, type KeyboardEvent, type ReactNode } from "react";

type NameSearchSelectProps = Omit<InputHTMLAttributes<HTMLInputElement>, "children" | "onChange" | "type" | "value"> & {
  children: ReactNode;
  value: string;
  onChange: (value: string) => void;
  searchPlaceholder?: string;
  optionNoun?: string;
};

type OptionProps = { value?: string | number; children?: ReactNode; disabled?: boolean };
type NameOption = { value: string; label: string; disabled: boolean };

function optionLabel(value: ReactNode): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(optionLabel).join("");
  if (isValidElement<{ children?: ReactNode }>(value)) return optionLabel(value.props.children);
  return "";
}

function firstEnabledOption(options: NameOption[]) {
  return options.findIndex((option) => !option.disabled);
}

export default function NameSearchSelect({
  children,
  value,
  onChange,
  searchPlaceholder = "Search names...",
  optionNoun = "name",
  disabled = false,
  required = false,
  ...inputProps
}: NameSearchSelectProps) {
  const [search, setSearch] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = `name-search-options-${useId()}`;

  const allOptions = Children.toArray(children).flatMap((child): NameOption[] => {
    if (!isValidElement<OptionProps>(child) || child.type !== "option") return [];
    const optionValue = String(child.props.value ?? "");
    if (!optionValue) return [];
    return [{ value: optionValue, label: optionLabel(child.props.children), disabled: Boolean(child.props.disabled) }];
  });
  const selectedOption = allOptions.find((option) => option.value === value);
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const filteredOptions = normalizedSearch
    ? allOptions.filter((option) => option.label.toLocaleLowerCase().includes(normalizedSearch))
    : allOptions;
  const displayValue = search || selectedOption?.label || "";
  const prompt = Children.toArray(children).find((child) => isValidElement<OptionProps>(child) && child.type === "option" && !child.props.value);
  const statusPlaceholder = prompt && isValidElement<OptionProps>(prompt) ? optionLabel(prompt.props.children) : "";
  const inputPlaceholder = disabled && statusPlaceholder ? statusPlaceholder : searchPlaceholder;
  const activeOption = filteredOptions[activeIndex];

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.setCustomValidity(required && !value && search.trim() ? `Select a ${optionNoun} from the suggestions.` : "");
  }, [optionNoun, required, search, value]);

  function selectOption(option: NameOption) {
    if (option.disabled) return;
    onChange(option.value);
    setSearch("");
    setIsOpen(false);
    setActiveIndex(-1);
  }

  function moveActiveOption(direction: 1 | -1) {
    const enabledIndexes = filteredOptions.flatMap((option, index) => option.disabled ? [] : [index]);
    if (!enabledIndexes.length) return;
    const currentPosition = enabledIndexes.indexOf(activeIndex);
    const nextPosition = currentPosition < 0
      ? direction === 1 ? 0 : enabledIndexes.length - 1
      : (currentPosition + direction + enabledIndexes.length) % enabledIndexes.length;
    setActiveIndex(enabledIndexes[nextPosition]);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!isOpen) {
        setIsOpen(true);
        setActiveIndex(firstEnabledOption(filteredOptions));
      } else {
        moveActiveOption(event.key === "ArrowDown" ? 1 : -1);
      }
    } else if (event.key === "Enter" && isOpen && activeOption) {
      event.preventDefault();
      selectOption(activeOption);
    } else if (event.key === "Escape" && isOpen) {
      event.preventDefault();
      setIsOpen(false);
      setSearch("");
      setActiveIndex(-1);
    }
  }

  function handleBlur(event: FocusEvent<HTMLDivElement>) {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    setIsOpen(false);
    setSearch("");
    setActiveIndex(-1);
  }

  return <div className="name-search-select" onBlur={handleBlur}>
    <input
      {...inputProps}
      ref={inputRef}
      className="name-search-select-search"
      type="search"
      role="combobox"
      aria-autocomplete="list"
      aria-expanded={isOpen}
      aria-controls={listboxId}
      aria-activedescendant={isOpen && activeOption ? `${listboxId}-${activeIndex}` : undefined}
      placeholder={inputPlaceholder}
      value={displayValue}
      required={required}
      disabled={disabled}
      autoComplete="off"
      onFocus={(event) => {
        const input = event.currentTarget;
        setIsOpen(true);
        setActiveIndex(firstEnabledOption(filteredOptions));
        if (selectedOption) requestAnimationFrame(() => input.select());
      }}
      onChange={(event) => {
        const nextSearch = event.currentTarget.value;
        setSearch(nextSearch);
        setIsOpen(true);
        setActiveIndex(firstEnabledOption(allOptions.filter((option) => option.label.toLocaleLowerCase().includes(nextSearch.trim().toLocaleLowerCase()))));
        if (value) onChange("");
      }}
      onKeyDown={handleKeyDown}
    />
    <button
      type="button"
      className="name-search-select-toggle"
      aria-label={isOpen ? `Hide ${optionNoun} suggestions` : `Show ${optionNoun} suggestions`}
      aria-expanded={isOpen}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        if (isOpen) {
          setIsOpen(false);
        } else {
          setIsOpen(true);
          setActiveIndex(firstEnabledOption(filteredOptions));
          requestAnimationFrame(() => inputRef.current?.focus());
        }
      }}
    ><span aria-hidden="true">⌄</span></button>
    {isOpen && <div className="name-search-select-menu" id={listboxId} role="listbox" aria-label={`${inputProps["aria-label"] ?? "Names"} suggestions`}>
      {filteredOptions.map((option, index) => <div
        key={option.value}
        id={`${listboxId}-${index}`}
        className={`name-search-select-option${index === activeIndex ? " is-active" : ""}${option.disabled ? " is-disabled" : ""}`}
        role="option"
        aria-selected={option.value === value}
        aria-disabled={option.disabled}
        onMouseDown={(event) => event.preventDefault()}
        onMouseEnter={() => setActiveIndex(index)}
        onClick={() => selectOption(option)}
      >{option.label}</div>)}
      {filteredOptions.length === 0 && <div className="name-search-select-empty" role="status">No matching {optionNoun}s.</div>}
    </div>}
  </div>;
}
