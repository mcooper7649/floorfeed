// The FloorFeed API client. One module per area, mirroring server/src/routes;
// `api` keeps every endpoint under one flat name.
import { accountApi } from './account';
import { launchApi } from './launch';
import { marketApi } from './market';
import { mintsApi } from './mints';
import { takesApi } from './takes';
import { tradeApi } from './trade';
import { walletApi } from './wallet';

export { apiUrl, setTokenGetter } from './client';
export type * from './account';
export type * from './launch';
export type * from './market';
export type * from './mints';
export type * from './takes';
export type * from './trade';
export type * from './wallet';

export const api = {
  ...marketApi,
  ...takesApi,
  ...accountApi,
  ...walletApi,
  ...tradeApi,
  ...mintsApi,
  ...launchApi,
};
