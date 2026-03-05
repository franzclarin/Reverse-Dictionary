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
}

export interface ErrorResponse {
  error: string;
  details?: string;
}
