import { TransactionRequest } from '@ethersproject/providers';
import { Contract } from '@ethersproject/contracts';
import _ from 'lodash';
import { assert } from 'ts-essentials';
import { GasRefundParticipation } from '../models/GasRefundParticipation';
import { GasRefundDistribution } from '../models/GasRefundDistribution';
import {
  CHAIN_ID_BINANCE,
  CHAIN_ID_FANTOM,
  CHAIN_ID_MAINNET,
  CHAIN_ID_POLYGON,
} from './constants';
import { EpochInfo } from './epoch-info';
import { GasRefundGenesisEpoch } from './gas-refund';
import { Provider } from './provider';
import BigNumber from 'bignumber.js';

const MerkleRedeemAbi = [
  'function seedAllocations(uint _week, bytes32 _merkleRoot, uint _totalAllocation)',
  'function claimStatus(address _liquidityProvider, uint _begin, uint _end) external view returns (bool[] memory)',
];

interface MerkleRedeem extends Contract {
  callStatic: {
    claimStatus(
      _liquidityProvider: string,
      _begin: number,
      _end: number,
    ): Promise<boolean[]>;
  };
}

const MerkleRedeemAddress: { [chainId: number]: string } = {
  // @TODO
  [CHAIN_ID_MAINNET]: '0xFEB7e2D8584BEf7BB21dA0B70C148DABf1388031',
  [CHAIN_ID_POLYGON]: '0xD15Fe65BCf0B612343E879434dc72DB1721F732D',
  [CHAIN_ID_FANTOM]: '0xCA82162e3666dbDf97814197Ae82731D857125dE',
  [CHAIN_ID_BINANCE]: '0x8fdcdAc765128F2A5CB2EB7Ed8990B2B24Cb66d7',
};

type GasRefundClaim = Pick<
  GasRefundParticipation,
  'epoch' | 'address' | 'refundedAmountPSP' | 'merkleProofs'
>;

type BaseGasRefundClaimsResponse<T> = {
  totalClaimable: T;
  claims: (Omit<GasRefundClaim, 'refundedAmountPSP'> & { amount: string })[];
};
type GasRefundClaimsResponseAcc = BaseGasRefundClaimsResponse<bigint>;
type GasRefundClaimsResponse = BaseGasRefundClaimsResponse<string> & {
  pendingClaimable: string
};

export class GasRefundApi {
  epochInfo: EpochInfo;
  merkleRedem: MerkleRedeem;

  static instances: { [network: number]: GasRefundApi } = {};

  constructor(protected network: number) {
    this.epochInfo = EpochInfo.getInstance(CHAIN_ID_MAINNET);
    this.merkleRedem = new Contract(
      MerkleRedeemAddress[network],
      MerkleRedeemAbi,
      Provider.getJsonRpcProvider(this.network),
    ) as unknown as MerkleRedeem;
  }

  static getInstance(network: number): GasRefundApi {
    if (!this.instances[network])
      this.instances[network] = new GasRefundApi(network);
    return this.instances[network];
  }

  // retrieve merkle root + compute tx params for last epoch
  async gasRefundDataForEpoch(epoch: number): Promise<{
    data: GasRefundDistribution;
    txParams: TransactionRequest;
  } | null> {
    const data = await GasRefundDistribution.findOne({
      where: { chainId: this.network, epoch },
      attributes: ['merkleRoot', 'epoch', 'chainId', 'totalPSPAmountToRefund'],
      raw: true,
    });

    if (!data) return null;

    const { merkleRoot, totalPSPAmountToRefund } = data;

    const txData = this.merkleRedem.interface.encodeFunctionData(
      'seedAllocations',
      [epoch, merkleRoot, totalPSPAmountToRefund],
    );

    return {
      data,
      txParams: {
        to: MerkleRedeemAddress[this.network],
        data: txData,
        chainId: this.network,
      },
    };
  }

  async _fetchMerkleData(address: string): Promise<GasRefundClaim[]> {
    const grpData = await GasRefundParticipation.findAll({
      attributes: ['epoch', 'address', 'refundedAmountPSP', 'merkleProofs'],
      where: { address, chainId: this.network, isCompleted: true },
      raw: true,
    });

    return grpData;
  }

  async _getClaimStatus(
    address: string,
    startEpoch: number,
    endEpoch: number,
  ): Promise<Record<number, boolean>> {
    const claimStatus = await this.merkleRedem.callStatic.claimStatus(
      address,
      startEpoch,
      endEpoch,
    );

    const epochToClaimed = claimStatus.reduce<Record<number, boolean>>(
      (acc, claimed, index) => {
        acc[startEpoch + index] = claimed;
        return acc;
      },
      {},
    );

    assert(
      Object.keys(epochToClaimed).length == endEpoch - startEpoch + 1,
      'logic error',
    );

    return epochToClaimed;
  }

  async _getCurrentEpochPendingRefundedAmount(address: string): Promise<string>{
    const epoch = await this.epochInfo.getCurrentEpoch();
    const grpData = await GasRefundParticipation.findAll({
      attributes: ['epoch', 'address', 'refundedAmountPSP'],
      where: { epoch, address, chainId: this.network, isCompleted: false },
      raw: true,
    });

    if(!grpData.length) return "0";
    
    const refundedAmount = BigNumber.sum(...grpData.map(({refundedAmountPSP}) => refundedAmountPSP)).toString(10)

    return refundedAmount;
  }

  // get all ever constructed merkle data for addrress
  async getAllGasRefundDataForAddress(
    address: string,
  ): Promise<GasRefundClaimsResponse> {
    const lastEpoch = (await this.epochInfo.getCurrentEpoch()) - 1;

    const startEpoch = GasRefundGenesisEpoch;
    const endEpoch = Math.max(lastEpoch, GasRefundGenesisEpoch);

    const [merkleData, epochToClaimed, pendingClaimable] = await Promise.all([
      this._fetchMerkleData(address),
      this._getClaimStatus(address, startEpoch, endEpoch),
      this._getCurrentEpochPendingRefundedAmount(address)
    ]);

    const { totalClaimable, claims } =
      merkleData.reduce<GasRefundClaimsResponseAcc>(
        (acc, claim) => {
          if (epochToClaimed[claim.epoch]) return acc;

          const { refundedAmountPSP, ...rClaim } = claim;
          acc.claims.push({ ...rClaim, amount: refundedAmountPSP });
          acc.totalClaimable += BigInt(refundedAmountPSP);

          return acc;
        },
        {
          totalClaimable: BigInt(0),
          claims: [],
        },
      );

    return {
      totalClaimable: totalClaimable.toString(),
      claims,
      pendingClaimable 
    };
  }

  async getAllEntriesForEpoch(
    epoch: number,
  ): Promise<GasRefundParticipation[]> {
    const grpData = await GasRefundParticipation.findAll({
      where: { epoch, chainId: this.network },
      raw: true,
    });

    return grpData;
  }
}