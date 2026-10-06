import { useCallback, useEffect, useState } from 'react';

export type ReadModelState<T> =
  | { status: 'loading'; data?: undefined; error?: undefined }
  | { status: 'success'; data: T; error?: undefined }
  | { status: 'empty'; data: T; error?: undefined }
  | { status: 'error'; data?: undefined; error: Error };

export function useReadModel<T>(loader: (signal: AbortSignal) => Promise<T>, isEmpty?: (data: T) => boolean) {
  const [state, setState] = useState<ReadModelState<T>>({ status: 'loading' });
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    loader(controller.signal)
      .then((data) => setState(isEmpty?.(data) ? { status: 'empty', data } : { status: 'success', data }))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setState({ status: 'error', error: error instanceof Error ? error : new Error('Unknown UI data error') });
      });
    return () => controller.abort();
  }, [isEmpty, loader, refreshKey]);

  const refresh = useCallback(() => {
    setState({ status: 'loading' });
    setRefreshKey((key) => key + 1);
  }, []);
  return { state, refresh };
}
