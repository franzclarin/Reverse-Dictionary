"use client";

import { ReverseDictionaryResponse } from "@/types";

interface ResultDisplayProps {
  result: ReverseDictionaryResponse | null;
  error: string | null;
}

export default function ResultDisplay({ result, error }: ResultDisplayProps) {
  if (error) {
    return (
      <div className="w-full max-w-3xl mt-8 p-6 bg-red-50 border-2 border-red-200 rounded-2xl dark:bg-red-900/20 dark:border-red-800">
        <h3 className="text-xl font-semibold text-red-800 dark:text-red-200 mb-2">Error</h3>
        <p className="text-red-700 dark:text-red-300">{error}</p>
      </div>
    );
  }

  if (!result) {
    return null;
  }

  return (
    <div className="w-full max-w-3xl mt-8 animate-fadeIn">
      <div className="p-8 bg-gradient-to-br from-blue-50 to-purple-50 border-2 border-blue-200 rounded-2xl shadow-lg dark:from-blue-900/20 dark:to-purple-900/20 dark:border-blue-700">
        {/* Main Word */}
        <div className="mb-6">
          <h2 className="text-5xl font-bold text-blue-900 dark:text-blue-100 mb-2">
            {result.word}
          </h2>
          <div className="h-1 w-20 bg-gradient-to-r from-blue-500 to-purple-500 rounded-full"></div>
        </div>

        {/* Definition */}
        <div className="mb-6">
          <h3 className="text-sm font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wide mb-2">
            Definition
          </h3>
          <p className="text-lg text-gray-800 dark:text-gray-200 leading-relaxed">
            {result.definition}
          </p>
        </div>

        {/* Examples */}
        {result.examples && result.examples.length > 0 && (
          <div className="mb-6">
            <h3 className="text-sm font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wide mb-2">
              Usage Examples
            </h3>
            <ul className="space-y-2">
              {result.examples.map((example, index) => (
                <li
                  key={index}
                  className="text-gray-700 dark:text-gray-300 pl-4 border-l-2 border-blue-300 dark:border-blue-600"
                >
                  {example}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Alternatives */}
        {result.alternatives && result.alternatives.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wide mb-2">
              Alternative Words
            </h3>
            <div className="flex flex-wrap gap-2">
              {result.alternatives.map((alt, index) => (
                <span
                  key={index}
                  className="px-4 py-2 bg-white dark:bg-gray-800 border border-blue-200 dark:border-blue-700 rounded-full text-sm font-medium text-gray-700 dark:text-gray-300"
                >
                  {alt}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
