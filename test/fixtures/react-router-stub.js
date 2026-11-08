// A stand-in for the router in component tests that only read and write the query string.
import { useState } from 'react';

export function useSearchParams() {
  const [params, setParams] = useState(() => new URLSearchParams());
  return [params, (next) => setParams(new URLSearchParams(next))];
}
