import { assert } from 'ts-essentials';
import { BigNumber } from 'bignumber.js';
import {
  fetchLastTimestampTxByContract,
  writeTransactions,
} from '../persistance/db-persistance';
import { getAllTXs, getContractAddresses } from './transaction-resolver';
import {
  GasRefundTransactionData,
  TransactionStatus,
  GasRefundV2EpochFlip,
  getRefundPercent,
  getMinStake,
} from '../../../src/lib/gas-refund/gas-refund';
import * as _ from 'lodash';
import { ONE_HOUR_SEC } from '../../../src/lib/utils/helpers';
import { PriceResolverFn } from '../token-pricing/psp-chaincurrency-pricing';
import StakesTracker from '../staking/stakes-tracker';
import { MIGRATION_SEPSP2_100_PERCENT_KEY } from '../staking/2.0/utils';

// empirically set to maximise on processing time without penalising memory and fetching constraigns
const SLICE_DURATION = 6 * ONE_HOUR_SEC;

export async function fetchRefundableTransactions({
  chainId,
  startTimestamp,
  endTimestamp,
  epoch,
  resolvePrice,
}: {
  chainId: number;
  startTimestamp: number;
  endTimestamp: number;
  epoch: number;
  resolvePrice: PriceResolverFn;
}): Promise<void> {
  const logger = global.LOGGER(
    `GRP:fetchRefundableTransactions: epoch=${epoch}, chainId=${chainId}`,
  );

  logger.info(`start indexing between ${startTimestamp} and ${endTimestamp}`);

  const lastTimestampTxByContract = await fetchLastTimestampTxByContract({
    chainId,
    epoch,
  });

  const contractAddresses = getContractAddresses({ epoch, chainId });

  await Promise.all(
    contractAddresses.map(async contractAddress => {
      assert(contractAddress, 'contractAddress should be defined');
      const lastTimestampProcessed =
        lastTimestampTxByContract[contractAddress] || 0;

      const _startTimestamp = Math.max(
        startTimestamp,
        lastTimestampProcessed + 1,
      );

      for (
        let _startTimestampSlice = _startTimestamp;
        _startTimestampSlice < endTimestamp;
        _startTimestampSlice += SLICE_DURATION
      ) {
        const _endTimestampSlice = Math.min(
          _startTimestampSlice + SLICE_DURATION,
          endTimestamp,
        );

        logger.info(
          `fetching transactions between ${_startTimestampSlice} and ${_endTimestampSlice} for contract=${contractAddress}...`,
        );

        const transactions = await getAllTXs({
          epoch,
          startTimestamp: _startTimestampSlice,
          endTimestamp: _endTimestampSlice,
          chainId,
          epochEndTimestamp: endTimestamp,
          contractAddress,
        });

        logger.info(
          `fetched ${transactions.length} txs between ${_startTimestampSlice} and ${_endTimestampSlice} for contract=${contractAddress}`,
        );

        const refundableTransactions: GasRefundTransactionData[] = [];

        transactions.forEach(transaction => {
          const address = transaction.txOrigin;

          const swapperStake =
            StakesTracker.getInstance().computeStakedPSPBalance(
              address,
              +transaction.timestamp,
              epoch,
              endTimestamp,
            );

          if (swapperStake.isLessThan(getMinStake(epoch))) {
            return;
          }

          const { txGasUsed, contract } = transaction;

          const currencyRate = resolvePrice(+transaction.timestamp);

          assert(
            currencyRate,
            `could not retrieve psp/chaincurrency same day rate for swap at ${transaction.timestamp}`,
          );

          const currGasUsed = new BigNumber(txGasUsed);

          const currGasUsedChainCur = currGasUsed.multipliedBy(
            transaction.txGasPrice.toString(),
          ); // in wei

          const currGasUsedUSD = currGasUsedChainCur
            .multipliedBy(currencyRate.chainPrice)
            .dividedBy(10 ** 18); // chaincurrency always encoded in 18decimals

          const currGasFeePSP = currGasUsedChainCur.dividedBy(
            currencyRate.pspToChainCurRate,
          );

          const totalStakeAmountPSP = swapperStake.toFixed(0); // @todo irrelevant?
          const refundPercent =
            contractAddress === MIGRATION_SEPSP2_100_PERCENT_KEY
              ? 1 // 100%
              : getRefundPercent(epoch, totalStakeAmountPSP);

          if (epoch < GasRefundV2EpochFlip) {
            assert(
              refundPercent,
              `Logic Error: failed to find refund percent for ${address}`,
            );
          }

          const currRefundedAmountPSP = currGasFeePSP.multipliedBy(
            refundPercent || 0,
          );

          const currRefundedAmountUSD = currRefundedAmountPSP
            .multipliedBy(currencyRate.pspPrice)
            .dividedBy(10 ** 18); // psp decimals always encoded in 18decimals

          const refundableTransaction: GasRefundTransactionData = {
            epoch,
            address,
            chainId,
            hash: transaction.txHash,
            block: +transaction.blockNumber,
            timestamp: +transaction.timestamp,
            gasUsed: txGasUsed,
            gasPrice: transaction.txGasPrice,
            gasUsedChainCurrency: currGasUsedChainCur.toFixed(0),
            pspUsd: currencyRate.pspPrice,
            chainCurrencyUsd: currencyRate.chainPrice,
            pspChainCurrency: currencyRate.pspToChainCurRate,
            gasUsedUSD: currGasUsedUSD.toFixed(), // purposefully not rounded to preserve dollar amount precision - purely debug / avoid 0$ values in db
            totalStakeAmountPSP,
            refundedAmountPSP: currRefundedAmountPSP.toFixed(0),
            refundedAmountUSD: currRefundedAmountUSD.toFixed(), // purposefully not rounded to preserve dollar amount precision [IMPORTANT FOR CALCULCATIONS]
            contract,
            status: TransactionStatus.IDLE,
            paraBoostFactor: 1,
          };

          refundableTransactions.push(refundableTransaction);
        });

        if (refundableTransactions.length > 0) {
          logger.info(
            `updating ${refundableTransactions.length} transactions for chainId=${chainId} epoch=${epoch} _startTimestampSlice=${_startTimestampSlice} _endTimestampSlice=${_endTimestampSlice}`,
          );
          await writeTransactions(refundableTransactions);
        }
      }
    }),
  );
}
