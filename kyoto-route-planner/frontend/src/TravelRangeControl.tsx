import { useEffect, useId, useState } from "react";

export function TravelRangeControl({ value, onChange, disabled = false, label = "出発地からの半径（km）", hint }: {
  value: number; onChange: (value: number) => void; disabled?: boolean; label?: string; hint?: string;
}) {
  const id = useId();
  const [input, setInput] = useState(String(value));
  useEffect(() => setInput(String(value)), [value]);
  return <label htmlFor={id}>{label}<input id={id} type="number" min="1" max="200" step="1" value={input}
    disabled={disabled} required aria-describedby={hint ? `${id}-hint` : undefined}
    onChange={event => {
      const next = event.target.value;
      setInput(next);
      const number = Number(next);
      if (next && Number.isInteger(number) && number >= 1 && number <= 200) onChange(number);
    }} onBlur={() => setInput(String(value))} />
    {hint && <small id={`${id}-hint`}>{hint}</small>}
  </label>;
}
