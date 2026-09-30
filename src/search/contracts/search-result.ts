export interface SearchResult {
  originalUrl: string;
  canonicalUrl: string;
  title: string;
  snippet: string;
  engines: string[];
  rank: number;
  query: string;
  retrievedAt: string;
}
