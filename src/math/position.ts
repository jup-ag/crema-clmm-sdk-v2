import { bundlrStorage, keypairIdentity, Metaplex } from '@metaplex-foundation/js'
import BN from "bn.js";
import { Connection, Keypair, PublicKey } from '@solana/web3.js'

import { MathUtil } from './utils'
import type { AccountFetcher } from '../network'
import { PDAUtil, SwapDirection } from '../utils'
import type { Percentage } from './percentage'
import { getLowerSqrtPriceFromTokenA, getLowerSqrtPriceFromTokenB, getUpperSqrtPriceFromTokenA, getUpperSqrtPriceFromTokenB } from './swap'
import { ZERO_BN } from '../types';

export enum AmountSpecified {
  Input = 'Specified input amount',
  Output = 'Specified output amount',
}

export enum PositionStatus {
  BelowRange,
  InRange,
  AboveRange,
}

/**
 * @category Position Util
 */
export class PositionUtil {
  private constructor() {}

  static getPositionStatus(currentTickIndex: number, lowerTickIndex: number, upperTickIndex: number): PositionStatus {
    if (currentTickIndex < lowerTickIndex) {
      return PositionStatus.BelowRange
    }
    if (currentTickIndex < upperTickIndex) {
      return PositionStatus.InRange
    }
    return PositionStatus.AboveRange
  }
}

/**
 * Adjust the amount of token A or token B to swap for in a swap to account for slippage.
 *
 * @param n - The amount of token A or token B to swap for.
 * @param numerator - The numerator of the slippage percentage.
 * @param denominator - The denominator of the slippage percentage.
 * @param adjustUp - Adjust the amount up or down.
 * @returns The adjusted amount of token A or token B to swap for.
 */
export function adjustForSlippage(n: BN, { numerator, denominator }: Percentage, adjustUp: boolean): BN {
  if (adjustUp) {
    return n.mul(denominator.add(numerator)).div(denominator)
  }
  return n.mul(denominator).div(denominator.add(numerator))
}

/**
 * Adjust the amount of token A or token B to swap for in a swap to account for slippage.
 *
 * @param amountIn - The amount of token A or token B to swap for.
 * @param amountOut - The amount of token A or token B to swap to.
 * @param numerator - The numerator of the slippage percentage.
 * @param denominator - The denominator of the slippage percentage.
 * @param amountSpecified - The amount specified in the swap.
 * @returns The adjusted amount of token A or token B to swap for.
 */
export function adjustAmountForSlippage(
  amountIn: BN,
  amountOut: BN,
  { numerator, denominator }: Percentage,
  amountSpecified: AmountSpecified
): BN {
  if (amountSpecified === AmountSpecified.Input) {
    return amountOut.mul(denominator).div(denominator.add(numerator))
  }
  return amountIn.mul(denominator.add(numerator)).div(denominator)
}

/**
 * Get liquidity from token A.
 *
 * @param amount - The amount of token A.
 * @param sqrtPriceLowerX64 - The lower sqrt price.
 * @param sqrtPriceUpperX64 - The upper sqrt price.
 * @param roundUp - If round up.
 * @returns liquidity.
 */
export function getLiquidityFromTokenA(amount: BN, sqrtPriceLowerX64: BN, sqrtPriceUpperX64: BN, roundUp: boolean) {
  const result = amount.mul(sqrtPriceLowerX64).mul(sqrtPriceUpperX64).div(sqrtPriceUpperX64.sub(sqrtPriceLowerX64))
  if (roundUp) {
    return MathUtil.shiftRightRoundUp(result)
  }
  return result.shrn(64)
}

/**
 * Get liquidity from token B.
 * @param amount - The amount of token B.
 * @param sqrtPriceLowerX64 - The lower sqrt price.
 * @param sqrtPriceUpperX64 - The upper sqrt price.
 * @param roundUp - If round up.
 *
 * @returns liquidity.
 */
export function getLiquidityFromTokenB(amount: BN, sqrtPriceLowerX64: BN, sqrtPriceUpperX64: BN, roundUp: boolean) {
  const numerator = amount.shln(64)
  const denominator = sqrtPriceUpperX64.sub(sqrtPriceLowerX64)
  if (roundUp) {
    return MathUtil.divRoundUp(numerator, denominator)
  }
  return numerator.div(denominator)
}

/**
 * Get amount of fixed delta.
 * @param currentSqrtPriceX64 - Current sqrt price.
 * @param targetSqrtPriceX64 - Target sqrt price.
 * @param liquidity - liqudity.
 * @param amountSpecified - The amount specified in the swap.
 * @param swapDirection - The swap direction.
 *
 * @returns
 */
export function getAmountFixedDelta(
  currentSqrtPriceX64: BN,
  targetSqrtPriceX64: BN,
  liquidity: BN,
  amountSpecified: AmountSpecified,
  swapDirection: SwapDirection
) {
  if ((amountSpecified === AmountSpecified.Input) === (swapDirection === SwapDirection.AtoB)) {
    return getTokenAFromLiquidity(liquidity, currentSqrtPriceX64, targetSqrtPriceX64, amountSpecified === AmountSpecified.Input)
  }
  return getTokenBFromLiquidity(liquidity, currentSqrtPriceX64, targetSqrtPriceX64, amountSpecified === AmountSpecified.Input)
}

/**
 * Get amount of unfixed delta.
 * @param currentSqrtPriceX64 - Current sqrt price.
 * @param targetSqrtPriceX64 - Target sqrt price.
 * @param liquidity - liqudity.
 * @param amountSpecified - The amount specified in the swap.
 * @param swapDirection - The swap direction.
 *
 * @returns
 */
export function getAmountUnfixedDelta(
  currentSqrtPriceX64: BN,
  targetSqrtPriceX64: BN,
  liquidity: BN,
  amountSpecified: AmountSpecified,
  swapDirection: SwapDirection
) {
  if ((amountSpecified === AmountSpecified.Input) === (swapDirection === SwapDirection.AtoB)) {
    return getTokenBFromLiquidity(liquidity, currentSqrtPriceX64, targetSqrtPriceX64, amountSpecified === AmountSpecified.Output)
  }
  return getTokenAFromLiquidity(liquidity, currentSqrtPriceX64, targetSqrtPriceX64, amountSpecified === AmountSpecified.Output)
}

/**
 * Get next sqrt price from swap.
 * @param sqrtPriceX64 - Current sqrt price.
 * @param liquidity - liquidity.
 * @param amount - Token amount.
 * @param amountSpecified - The amount specified in the swap.
 * @param swapDirection - The swap direction.
 *
 * @returns
 */
export function getNextSqrtPrice(
  sqrtPriceX64: BN,
  liquidity: BN,
  amount: BN,
  amountSpecified: AmountSpecified,
  swapDirection: SwapDirection
) {
  if (amountSpecified === AmountSpecified.Input && swapDirection === SwapDirection.AtoB) {
    return getLowerSqrtPriceFromTokenA(amount, liquidity, sqrtPriceX64)
  }
  if (amountSpecified === AmountSpecified.Output && swapDirection === SwapDirection.BtoA) {
    return getUpperSqrtPriceFromTokenA(amount, liquidity, sqrtPriceX64)
  }
  if (amountSpecified === AmountSpecified.Input && swapDirection === SwapDirection.BtoA) {
    return getUpperSqrtPriceFromTokenB(amount, liquidity, sqrtPriceX64)
  }
  return getLowerSqrtPriceFromTokenB(amount, liquidity, sqrtPriceX64)
}

/**
 * Get token A from liquidity.
 * @param liquidity - liquidity.
 * @param sqrtPrice0X64 - Current sqrt price of token 0.
 * @param sqrtPrice1X64 - Current sqrt price of token 1.
 * @param roundUp - If round up.
 *
 * @returns
 */
export function getTokenAFromLiquidity(liquidity: BN, sqrtPrice0X64: BN, sqrtPrice1X64: BN, roundUp: boolean) {
  const [sqrtPriceLowerX64, sqrtPriceUpperX64] = orderSqrtPrice(sqrtPrice0X64, sqrtPrice1X64)

  const numerator = liquidity.mul(sqrtPriceUpperX64.sub(sqrtPriceLowerX64)).shln(64)
  const denominator = sqrtPriceUpperX64.mul(sqrtPriceLowerX64)
  if (roundUp) {
    return MathUtil.divRoundUp(numerator, denominator)
  }
  return numerator.div(denominator)
}

/**
 * Get token B from liquidity.
 * @param liquidity - liqudity.
 * @param sqrtPrice0X64 - Current sqrt price of token 0.
 * @param sqrtPrice1X64 - Current sqrt price of token 1.
 * @param roundUp - If round up.
 *
 * @returns
 */
export function getTokenBFromLiquidity(liquidity: BN, sqrtPrice0X64: BN, sqrtPrice1X64: BN, roundUp: boolean) {
  const [sqrtPriceLowerX64, sqrtPriceUpperX64] = orderSqrtPrice(sqrtPrice0X64, sqrtPrice1X64)

  const result = liquidity.mul(sqrtPriceUpperX64.sub(sqrtPriceLowerX64))
  if (roundUp) {
    return MathUtil.shiftRightRoundUp(result)
  }
  return result.shrn(64)
}

/**
 * Get all positions address form  pool.
 * @param connection - Solana connection.
 * @param wallet - Wallet address
 * @param programId - Solana program id
 * @param fetcher - Solana fetcher
 * @param pool - Clmm pood address
 *
 * @returns
 */
export async function getAllPositionsFromPool(
  connection: Connection,
  wallet: PublicKey,
  programId: PublicKey,
  fetcher: AccountFetcher,
  pool: PublicKey,
) {
  const metaplex = Metaplex.make(connection)
  .use(bundlrStorage());

  const allNFTs = await metaplex
      .nfts()
      .findAllByOwner({ owner: wallet })
      .run();

  const positionsAddress = [];
  for (const n of allNFTs) {
      if (n.model === "metadata") {
          const position = PDAUtil.getPositionPDA(programId, n.mintAddress);
          positionsAddress.push(position.publicKey);
      }
  }

  const positions = await fetcher.listPositions(positionsAddress, true);
  let res = [];
  for (let i=0; i<positions.length; i++ ) {
      if (positions[i]?.clmmpool.toString() === pool.toString() && positions[i]?.liquidity !== ZERO_BN ) {
          res.push(positionsAddress[i])
      }
  }
  return res;
}

/**
 * Get all positions.
 * @param connection - Solana connection.
 * @param wallet - Wallet address
 * @param programId - Solana program id
 * @param fetcher - Solana fetcher
 *
 * @returns
 */
export async function getAllPositions(connection: Connection, wallet: Keypair, programId: PublicKey, fetcher: AccountFetcher) {
  const metaplex = Metaplex.make(connection).use(keypairIdentity(wallet)).use(bundlrStorage())

  const allNFTs = await metaplex.nfts().findAllByOwner({ owner: wallet.publicKey }).run()

  const positionsAddress = []
  for (const n of allNFTs) {
    if (n.model === 'metadata') {
      const position = PDAUtil.getPositionPDA(programId, n.mintAddress)
      positionsAddress.push({
        positionPublicKey: position.publicKey,
        nftTokenAccount: n.address,
      })
    }
  }

  const positionsAddrs: any = []
  for (const p of positionsAddress) {
    positionsAddrs.push(p.positionPublicKey)
  }
  const positions = await fetcher.listPositions(positionsAddrs, true)

  const positionsWithNftandAddress = []
  for (const i in positionsAddress) {
    if (!positions[i]) {
      continue
    }

    positionsWithNftandAddress.push({
      ...positions[i],
      ...positionsAddress[i],
    })
  }

  return positionsWithNftandAddress
}

/**
 * Order sqrt price.
 * @param liquidity - liqudity.
 * @param sqrtPrice0X64 - Current sqrt price of token 0.
 * @param sqrtPrice1X64 - Current sqrt price of token 1.
 *
 * @returns
 */
function orderSqrtPrice(sqrtPrice0X64: BN, sqrtPrice1X64: BN): [BN, BN] {
  if (sqrtPrice0X64.lt(sqrtPrice1X64)) {
    return [sqrtPrice0X64, sqrtPrice1X64]
  }
  return [sqrtPrice1X64, sqrtPrice0X64]
}
