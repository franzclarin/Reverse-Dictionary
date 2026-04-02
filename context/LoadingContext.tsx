"use client";

import { createContext, useContext, useState, useEffect } from "react";
import { usePathname } from "next/navigation";

const LOADING_MESSAGES = [
  "Searching the lexicon",
  "Consulting the archives",
  "Parsing your description",
  "Scanning 171,476 words",
  "Almost there",
];

interface LoadingContextType {
  startLoading: () => void;
  stopLoading: () => void;
  isLoading: boolean;
}

const LoadingContext = createContext<LoadingContextType>({
  startLoading: () => {},
  stopLoading: () => {},
  isLoading: false,
});

export function LoadingProvider({ children }: { children: React.ReactNode }) {
  const [isLoading, setIsLoading] = useState(false);
  const [messageIndex, setMessageIndex] = useState(0);
  const pathname = usePathname();

  // Auto-stop when route changes
  useEffect(() => {
    setIsLoading(false);
  }, [pathname]);

  // Cycle messages while loading
  useEffect(() => {
    if (!isLoading) return;
    const interval = setInterval(() => {
      setMessageIndex((i) => (i + 1) % LOADING_MESSAGES.length);
    }, 2000);
    return () => clearInterval(interval);
  }, [isLoading]);

  return (
    <LoadingContext.Provider
      value={{
        startLoading: () => setIsLoading(true),
        stopLoading: () => setIsLoading(false),
        isLoading,
      }}
    >
      {children}
      {isLoading && (
        <div className="loading-overlay">
          <div className="loading-content">
            <div className="loading-symbol">◈</div>
            <div className="loading-dots">
              <span>Finding</span>
              <span className="dot">.</span>
              <span className="dot">.</span>
              <span className="dot">.</span>
            </div>
            <p className="loading-subtext">{LOADING_MESSAGES[messageIndex]}</p>
          </div>
        </div>
      )}
    </LoadingContext.Provider>
  );
}

export const useLoading = () => useContext(LoadingContext);
