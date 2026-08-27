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
