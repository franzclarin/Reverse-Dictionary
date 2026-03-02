"use client";

interface ExampleQueriesProps {
  onSelectExample: (example: string) => void;
  isLoading: boolean;
}

const EXAMPLES = [
  "the smell of rain on dry earth",
  "fear of long words",
  "a story told from inside the story",
  "the day after tomorrow",
  "pleasure derived from others' misfortune",
  "unable to be read or deciphered",
];

export default function ExampleQueries({ onSelectExample, isLoading }: ExampleQueriesProps) {
  return (
    <div className="w-full max-w-3xl mt-6">
      <p className="text-sm text-gray-600 dark:text-gray-400 mb-3 font-medium">
        Try these examples:
      </p>
      <div className="flex flex-wrap gap-2">
        {EXAMPLES.map((example, index) => (
          <button
            key={index}
            onClick={() => onSelectExample(example)}
            disabled={isLoading}
            className="px-4 py-2 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-full text-sm text-gray-700 dark:text-gray-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {example}
          </button>
        ))}
      </div>
    </div>
  );
}
