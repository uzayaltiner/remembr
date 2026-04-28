import React, { type FC } from 'react';
import type { SearchResult } from '../core/store.js';
import { SearchView } from './views/SearchView.js';

export interface AppProps {
  onChoose: (result: SearchResult | null) => void;
}

export const App: FC<AppProps> = ({ onChoose }) => {
  return <SearchView onChoose={onChoose} />;
};
