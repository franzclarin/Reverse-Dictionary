export interface ReverseDictionaryRequest {
  description: string;
}

export interface ReverseDictionaryResponse {
  word: string;
  definition: string;
  alternatives?: string[];
  examples?: string[];
}

export interface ErrorResponse {
  error: string;
  details?: string;
}
