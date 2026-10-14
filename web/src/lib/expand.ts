import { createContext } from 'react';

/** Lets a node's chips toggle its expansion without threading callbacks through node data. */
export const ExpandContext = createContext<(nodeId: string) => void>(() => {});
