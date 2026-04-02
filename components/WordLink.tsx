"use client";

import Link from "next/link";
import { useLoading } from "@/context/LoadingContext";

interface Props {
  word: string;
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}

export default function WordLink({ word, className, style, children }: Props) {
  const { startLoading } = useLoading();

  return (
    <Link
      href={`/word/${encodeURIComponent(word)}`}
      onClick={() => startLoading()}
      className={className}
      style={style}
    >
      {children}
    </Link>
  );
}
