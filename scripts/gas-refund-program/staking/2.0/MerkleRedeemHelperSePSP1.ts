import * as pMemoize from 'p-memoize';
import { constructHttpClient } from '../../../../src/lib/utils/http-client';
// this should match to `type FileMerkleTreeData`
export type MerkleRoot = {
  merkleRoot: string;
  totalAmount: string;
  epoch: number;
};
export type MerkleData = {
  proof: string[];
  address: string;
  amount: string;
  epoch: number;
};

export type MerkleTreeData = {
  root: MerkleRoot;
  merkleProofs: MerkleData[];
};

// @TODO: create separate repo just for this config?
const TREE_DATA_URL_BY_EPOCH_URL =
  'https://raw.githubusercontent.com/paraswap/paraswap-volume-tracker/master/scripts/gas-refund-program/distributions.json';
const TREE_DATA_URL_BY_EPOCH_CACHE_MAX_AGE_MS = 60 * 5 * 1000; // 5 minutes
type UrlByEpoch = Record<number, string>;
const httpClientWithTempCache = constructHttpClient({
  cacheOptions: {
    // debug: console.log, // will refetch on `cache-miss` and `cache-stale`
    maxAge: TREE_DATA_URL_BY_EPOCH_CACHE_MAX_AGE_MS,
  },
});
const fetchTreeDataUrlByLegacyEpoch = async (): Promise<UrlByEpoch> =>
  (await httpClientWithTempCache.get<UrlByEpoch>(TREE_DATA_URL_BY_EPOCH_URL))
    .data;

const _fetchEpochData = async (url: string): Promise<MerkleTreeData> =>
  (await httpClientWithTempCache.get<MerkleTreeData>(url)).data;

// stored on ipfs and is immutable, so can cache forever
const fetchEpochData = pMemoize(_fetchEpochData, {
  cacheKey: ([url]) => `epochData_${url}`,
});

export type MerkleTreeDataByEpoch = Record<number, MerkleTreeData>;
export class MerkleRedeemHelperSePSP1 {
  private static instance: MerkleRedeemHelperSePSP1;

  private cacheData?: {
    cacheKey: string;
    merkleDataByEpoch: MerkleTreeDataByEpoch;
  };

  static getInstance() {
    if (!MerkleRedeemHelperSePSP1.instance) {
      MerkleRedeemHelperSePSP1.instance = new MerkleRedeemHelperSePSP1();
    }
    return MerkleRedeemHelperSePSP1.instance;
  }

  async getMerkleDataByEpochWithCacheKey(): Promise<{
    merkleDataByEpoch: MerkleTreeDataByEpoch;
    cacheKey: string;
  }> {
    const merkleTreeDataUrlByLegacyEpoch =
      await fetchTreeDataUrlByLegacyEpoch();
    const newCacheKey = JSON.stringify(merkleTreeDataUrlByLegacyEpoch);

    if (!this.cacheData || this.cacheData.cacheKey !== newCacheKey) {
      const promises = Object.keys(merkleTreeDataUrlByLegacyEpoch)
        .map(Number)
        .map(async epoch => ({
          epoch,
          data: await fetchEpochData(merkleTreeDataUrlByLegacyEpoch[epoch]),
        }));

      const datas = await Promise.all(promises);

      const merkleDataByEpoch = datas.reduce<MerkleTreeDataByEpoch>(
        (acc, { epoch, data }) => ({ ...acc, [epoch]: data }),
        {},
      );

      this.cacheData = {
        merkleDataByEpoch,
        cacheKey: JSON.stringify(merkleTreeDataUrlByLegacyEpoch),
      };
    }
    return this.cacheData;
  }
}
