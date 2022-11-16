import type { PublicKey } from "@solana/web3.js";
import BN from "bn.js";

import type { SwapInput } from "../ix";
import { MathUtil, U64_MAX, ZERO } from "../math/utils";
import type { AccountFetcher } from "../network/fetcher";
import type { TickArray } from '../types';
import * as constants from "../types/constants";
import { PDAUtil, TickUtil } from '../utils';
import type { Percentage } from "./percentage";


/**
 * Adjust the amount of token A or token B to swap for in a swap to account for slippage.
 * 
 * @param n - The amount of token A or token B to swap for.
 * @param numerator - The numerator of the slippage percentage.
 * @param denominator - The denominator of the slippage percentage.
 * @param adjustUp - Adjust the amount up or down.
 * @returns The adjusted amount of token A or token B to swap for.
 */
 export function adjustForSlippage(
  n: BN,
  { numerator, denominator }: Percentage,
  adjustUp: boolean
  ): BN {
  if (adjustUp) {
      return n.mul(denominator.add(numerator)).div(denominator);
  } else {
      return n.mul(denominator).div(denominator.add(numerator));
  }
  }

export class SwapUtils {
  /**
   * Get the default sqrt price limit for a swap.
   * 
   * @param a2b - true if the swap is A to B, false if the swap is B to A.
   * @returns The default sqrt price limit for the swap.
   */
  static getDefaultSqrtPriceLimit(a2b: boolean): BN {
    return new BN(a2b ? constants.MIN_SQRT_PRICE : constants.MAX_SQRT_PRICE);
  }

  /**
   * Get the default values for the otherAmountThreshold in a swap.
   * 
   * @param amountSpecifiedIsInput - The direction of a swap
   * @returns The default values for the otherAmountThreshold parameter in a swap.
   */
  static getDefaultOtherAmountThreshold(amountSpecifiedIsInput: boolean): BN {
    return amountSpecifiedIsInput ? ZERO : U64_MAX;
  }

  /**
   * Get tick array publicKeys for a given tick index.
   * 
   * @param currentTickIndex - The current tickIndex for the Clmmpool to swap on.
   * @param tickSpacing - The tickSpacing for the Clmmpool.
   * @param programId - The Clmmpool programId which the Clmmpool lives on.
   * @param clmmpoolAddress - PublicKey of the clmmpool to swap on.
   * @returns An array of PublicKey[] for the tickArray accounts that this swap may traverse across.
   **/
  static getTickArrayPublicKeys(
    currentTickIndex: number,
    tickSpacing: number,
    programId: PublicKey,
    clmmpoolAddress: PublicKey
  ): PublicKey[] {
    const tickArrayAddresses: PublicKey[] = [];
    for (let i = 0; i < constants.TICK_ARRAY_MAP_MAX_BIT_INDEX; i++) {
      let arrayIndex: number;
      try {
        arrayIndex = TickUtil.getArrayIndex(currentTickIndex, tickSpacing);
      } catch {
        return tickArrayAddresses;
      }

      const pda = PDAUtil.getTickArrayPDA(
        programId,
        clmmpoolAddress,
        arrayIndex
      );
      tickArrayAddresses.push(pda.publicKey);
    }

    return tickArrayAddresses;
  }

  /**
   * Given the current tick-index, returns TickArray objects that this swap may traverse across.
   *
   * @param currentTickIndex - The current tickIndex for the Clmmpool to swap on.
   * @param tickSpacing - The tickSpacing for the Clmmpool.
   * @param programId - The Clmmpool programId which the Clmmpool lives on.
   * @param clmmpoolAddress - PublicKey of the clmmpool to swap on.
   * @param fetcher - AccountFetcher object to fetch solana accounts
   * @param refresh - If true, fetcher would default to fetching the latest accounts
   * @returns An array of PublicKey[] for the tickArray accounts that this swap may traverse across.
   */
  static async getTickArrays(
    currentTickIndex: number,
    tickSpacing: number,
    programId: PublicKey,
    clmmpoolAddress: PublicKey,
    fetcher: AccountFetcher,
    refresh: boolean
  ): Promise<TickArray[]> {
    const addresses = SwapUtils.getTickArrayPublicKeys(
      currentTickIndex,
      tickSpacing,
      programId,
      clmmpoolAddress
    );
    const data = await fetcher.listTickArrays(addresses, refresh);
    return addresses.map((addr, index) => {
      return {
        address: addr,
        data: data[index]!,
      };
    });
  }

  /**
   * Calculate the SwapInput parameters `amount` & `otherAmountThreshold` based on the amountIn & amountOut estimates from a quote.
   * @param amount - The amount of tokens the user wanted to swap from.
   * @param estAmountIn - The estimated amount of input tokens expected in a `SwapQuote`
   * @param estAmountOut - The estimated amount of output tokens expected from a `SwapQuote`
   * @param slippageTolerance - The amount of slippage to adjust for.
   * @param amountSpecifiedIsInput - Specifies the token the parameter `amount`represents in the swap quote. If true, the amount represents
   *                                 the input token of the swap.
   * @returns A Partial `SwapInput` object containing the slippage adjusted 'amount' & 'otherAmountThreshold' parameters.
   */
  static calculateSwapAmountsFromQuote(
    amount: BN,
    estAmountIn: BN,
    estAmountOut: BN,
    slippageTolerance: Percentage,
    amountSpecifiedIsInput: boolean
  ): Pick<SwapInput, "amount" | "amountLimit"> {
    if (amountSpecifiedIsInput) {
      return {
        amount,
        amountLimit: adjustForSlippage(estAmountOut, slippageTolerance, false),
      };
    } else {
      return {
        amount,
        amountLimit: adjustForSlippage(estAmountIn, slippageTolerance, true),
      };
    }
  }
}

/**
 * Get lower sqrt price from token A.
 * 
 * @param amount - The amount of tokens the user wanted to swap from.
 * @param liquidity - The liquidity of the pool.
 * @param sqrtPriceX64 - The sqrt price of the pool.
 * @returns LowesqrtPriceX64
 */
export function getLowerSqrtPriceFromTokenA(
  amount: BN,
  liquidity: BN,
  sqrtPriceX64: BN
): BN {
  const numerator = liquidity.mul(sqrtPriceX64).shln(64);
  const denominator = liquidity.shln(64).add(amount.mul(sqrtPriceX64));

  // always round up
  return MathUtil.divRoundUp(numerator, denominator);
}

/**
 * Get upper sqrt price from token A.
 * 
 * @param amount - The amount of tokens the user wanted to swap from.
 * @param liquidity - The liquidity of the pool.
 * @param sqrtPriceX64 - The sqrt price of the pool.
 * @returns LowesqrtPriceX64
 */
export function getUpperSqrtPriceFromTokenA(
  amount: BN,
  liquidity: BN,
  sqrtPriceX64: BN
): BN {
  const numerator = liquidity.mul(sqrtPriceX64).shln(64);
  const denominator = liquidity.shln(64).sub(amount.mul(sqrtPriceX64));

  // always round up
  return MathUtil.divRoundUp(numerator, denominator);
}

/**
 * Get lower sqrt price from token B.
 * 
 * @param amount - The amount of tokens the user wanted to swap from.
 * @param liquidity - The liquidity of the pool.
 * @param sqrtPriceX64 - The sqrt price of the pool.
 * @returns LowesqrtPriceX64
 */
export function getLowerSqrtPriceFromTokenB(
  amount: BN,
  liquidity: BN,
  sqrtPriceX64: BN
): BN {
  // always round down(rounding up a negative number)
  return sqrtPriceX64.sub(MathUtil.divRoundUp(amount.shln(64), liquidity));
}

/**
 * Get upper sqrt price from token B.
 * 
 * @param amount - The amount of tokens the user wanted to swap from.
 * @param liquidity - The liquidity of the pool.
 * @param sqrtPriceX64 - The sqrt price of the pool.
 * @returns LowesqrtPriceX64
 */
export function getUpperSqrtPriceFromTokenB(
  amount: BN,
  liquidity: BN,
  sqrtPriceX64: BN
): BN {
  // always round down (rounding up a negative number)
  return sqrtPriceX64.add(amount.shln(64).div(liquidity));
}
