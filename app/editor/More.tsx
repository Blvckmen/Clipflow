"use client";
// "More controls": the less used settings of a step, folded away until asked for.
import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

export function More({ children, label = "More controls" }: { children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  return <div className={"more" + (open ? " open" : "")}>
    <button type="button" className="more-toggle" aria-expanded={open} onClick={() => setOpen(o => !o)}><ChevronDown size={15} />{open ? "Fewer controls" : label}</button>
    {open && <div className="more-body">{children}</div>}
  </div>;
}
