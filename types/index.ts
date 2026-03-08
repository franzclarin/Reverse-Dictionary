export interface ReverseDictionaryRequest {
  description: string;
}

export interface RateLimitInfo {
  remaining: number;
  limit: number;
  isGuest: boolean;
}

export interface ReverseDictionaryResponse {
  word: string;
  definition: string;
  alternatives?: string[];
  examples?: string[];
  rateLimit?: RateLimitInfo;
  creditsAwarded?: number;
}

export interface ErrorResponse {
  error: string;
  details?: string;
}

export interface WordProfile {
  id: string;
  word: string;
  partOfSpeech: string;
  definition: string;
  pronunciation: string;
  etymology: string;
  examples: string[];
  synonyms: string[];
  domain: string;
  createdAt: Date;
}
