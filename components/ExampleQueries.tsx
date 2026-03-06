"use client";

interface ExampleQueriesProps {
  onSelectExample: (example: string) => void;
  isLoading: boolean;
}

const EXAMPLES = [
  "the smell of rain on dry earth",
  "happy and sad at the same time",
  "fear of long words",
  "a story told from the narrator's perspective",
  "the urge to squeeze cute things",
];

export default function ExampleQueries({
  onSelectExample,
  isLoading,
}: ExampleQueriesProps) {
  return (
    <div className="w-full">
      <p
        className="font-mono text-[10px] uppercase tracking-widest mb-3"
        style={{ color: "var(--text-secondary)" }}
      >
        Try an example
      </p>
      <div className="flex flex-wrap gap-2">
        {EXAMPLES.map((example, index) => (
          <button
            key={index}
            onClick={() => onSelectExample(example)}
            disabled={isLoading}
            className="px-3 py-1.5 font-mono text-xs rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            style={{
              color: "var(--text-secondary)",
              border: "1px solid var(--border)",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = "rgba(201,168,76,0.4)";
              e.currentTarget.style.color = "var(--accent-gold)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = "var(--border)";
              e.currentTarget.style.color = "var(--text-secondary)";
            }}
          >
            &ldquo;{example}&rdquo;
          </button>
        ))}
      </div>
    </div>
  );
}
