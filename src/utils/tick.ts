import type { PublicKey } from "@solana/web3.js";
import { BN } from "bn.js";
import invariant from "tiny-invariant";

import type { ClmmpoolContext } from "../context";
import { ZERO } from "../math/utils";
import type { AccountFetcher } from "../network";
import type { ClmmpoolData, TickArrayData, TickData } from "../types/clmmpool";
import {
  MAX_TICK_INDEX,
  MIN_TICK_INDEX,
  TICK_ARRAY_SIZE,
} from "../types/constants";
import { PDAUtil } from "./pda";

/**
 * A collection of utility functions when interacting with a Tick.
 * There are some functions already initialized in tick math.
 * @category Tick Utils
 */
export class TickUtil {
  /**
   * Verify is tick initializeable.
   *
   * @param tick
   * @param tickSpacing
   * @returns
   */
  static isTickInitializable(tick: number, tickSpacing: number): boolean {
    return tick % tickSpacing === 0;
  }

  /**
   * Check if the tick is in bounds.
   *
   * @param tick - tick index
   * @retruns true or false
   */
  static checkTickInBounds(tick: number): boolean {
    return tick <= MAX_TICK_INDEX && tick >= MIN_TICK_INDEX;
  }

  /**
   * Check if the tick is valid.
   *
   * @param tick_index - tick index
   * @param tick_spacing - tick spacing
   * @retruns
   */
  static checkIsValidTick(tick_index: number, tick_spacing: number): void {
    const min = this.getMinIndex(tick_spacing);
    const max = this.getMaxIndex(tick_spacing);
    invariant(tick_index >= min && tick_index <= max, `tick index invalid`);
    invariant(tick_index % tick_spacing === 0, `tick index invalid`);
  }

  /**
   * Get min tick index.
   *
   * @param tick_spacing - tick spacing
   * @retruns min tick index
   */
  static getMinIndex(tick_spacing: number): number {
    return MIN_TICK_INDEX + (Math.abs(MIN_TICK_INDEX) % tick_spacing);
  }

  /**
   * Get max tick index.
   * @param tick_spacing - tick spacing
   * @retruns max tick index
   */
  static getMaxIndex(tick_spacing: number): number {
    return MAX_TICK_INDEX - (MAX_TICK_INDEX % tick_spacing);
  }

  /**
   * Get array index.
   *
   * @param tick_index - tick index
   * @param tick_spacing - tick spacing
   * @retruns max tick index
   */
  static getArrayIndex(tick_index: number, tick_spacing: number): number {
    const min = this.getMinIndex(tick_spacing);
    const max = this.getMaxIndex(tick_spacing);

    invariant(tick_index >= min && tick_index <= max, `tick index invalid`);

    const array_spacing = TICK_ARRAY_SIZE * tick_spacing;
    return Math.floor((tick_index - min) / array_spacing);
  }

  /**
   * Get offset index.
   *
   * @param tick_index - tick index
   * @param tick_spacing - tick spacing
   * @retruns offset index
   */
  static getOffset(tick_index: number, tick_spacing: number): number {
    const array_index = this.getArrayIndex(tick_index, tick_spacing);
    const start_index = this.getStartTickIndex(array_index, tick_spacing);
    return Math.floor((tick_index - start_index) / tick_spacing);
  }

  /**
   * Get start tick index.
   *
   * @param array_index - tick index
   * @param tick_spacing - tick spacing
   * @retruns start tick index
   */
  static getStartTickIndex(array_index: number, tick_spacing: number): number {
    const min = this.getMinIndex(tick_spacing);
    const array_spacing = TICK_ARRAY_SIZE * tick_spacing;
    return min + array_spacing * array_index;
  }

  /**
   * Get end tick index.
   *
   * @param array_index - tick index
   * @param tick_spacing - tick spacing
   * @retruns end tick index
   */
  static getEndTickIndex(array_index: number, tick_spacing: number): number {
    const start_index = this.getStartTickIndex(array_index, tick_spacing);
    return start_index + (TICK_ARRAY_SIZE - 1) * tick_spacing;
  }

  /**
   * Verify if the tickArray is min.
   *
   * @param array_index - array index
   * @param tick_spacing - tick spacing
   * @retruns true or false
   */
  static isMinTickArray(array_index: number, tick_spacing: number): boolean {
    return (
      this.getStartTickIndex(array_index, tick_spacing) ===
      this.getMinIndex(tick_spacing)
    );
  }

  /**
   * Verify if the tickArray is max.
   *
   * @param array_index - array index
   * @param tick_spacing - tick spacing
   * @retruns true or false
   */
  static isMaxTickArray(array_index: number, tick_spacing: number): boolean {
    return (
      this.getEndTickIndex(array_index, tick_spacing) ===
      this.getMaxIndex(tick_spacing)
    );
  }

  /**
   * Verify if the tick is in tickArray
   *
   * @param array_index - array index
   * @param tick_spacing - tick spacing
   * @param tick_index - tick index
   * @retruns true or false
   */
  static isInArray(
    array_index: number,
    tick_spacing: number,
    tick_index: number
  ): boolean {
    return (
      tick_index >= this.getStartTickIndex(array_index, tick_spacing) &&
      tick_index <= this.getEndTickIndex(array_index, tick_spacing)
    );
  }

  /**
   * Cross update.
   *
   * @param tick - index data
   * @param pool - clmm pool address
   * @param aToB - swap direcation
   * @retruns true or false
   */
  static crossUpdate(tick: TickData, pool: ClmmpoolData, aToB: boolean) {
    const liquidity = pool.liquidity;
    const signedLiquidityChange = aToB
      ? tick.liquidityNet.mul(new BN(-1))
      : tick.liquidityNet;
    const currentLiquidity = signedLiquidityChange.gt(ZERO)
      ? liquidity.add(signedLiquidityChange)
      : liquidity.sub(signedLiquidityChange.abs());

    return currentLiquidity;
  }

  /**
   * Get tick data from tick index.
   *
   * @param fetcher - solana fetcher
   * @param clmmpool - clmm pool address
   * @param programId - SPL Token program account
   * @param tick_index - tick index
   * @param tick_spacing - tick spacing
   * @retruns tick data
   */
  static async getTickDataFromIndex(
    fetcher: AccountFetcher,
    clmmpool: PublicKey,
    programId: PublicKey,
    tick_index: number,
    tick_spacing: number
  ): Promise<TickData> {
    const arrayIndex = this.getArrayIndex(tick_index, tick_spacing);
    const offset = this.getOffset(tick_index, tick_spacing);
    const tickArrayAddress = PDAUtil.getTickArrayPDA(
      programId,
      clmmpool,
      arrayIndex
    ).publicKey;
    const tickArray = await fetcher.getTickArray(tickArrayAddress, false);

    const tickData = tickArray!.ticks[offset];
    return tickData!;
  }
}

/**
 * A collection of utility functions when interacting with a TickArray.
 * @category TickArray Utils
 */
export class TickArrayUtil {
  /**
   * Evaluate a list of tick-array data and return the array of indices which the tick-arrays are not initialized.
   * @param tickArrays - a list of TickArrayData or null objects from AccountFetcher.listTickArrays
   * @returns an array of array-index for the input tickArrays that requires initialization.
   */
  static getUninitializedArrays(
    tickArrays: (TickArrayData | null)[]
  ): number[] {
    return tickArrays
      .map((value, index) => {
        if (!value) {
          return index;
        }
        return -1;
      })
      .filter((index) => index >= 0);
  }
}

/**
 * Get all ticks.
 *
 * @param ctx
 * @param programId
 * @param tick_spacing
 * @param clmmpool
 * @returns all ticks
 */
export async function getAllTicks(
  ctx: ClmmpoolContext,
  programId: PublicKey,
  tick_spacing: number,
  clmmpool: PublicKey
): Promise<TickData[]> {
  const maxIndex = TickUtil.getMaxIndex(tick_spacing);
  const maxTickArrayIndex = TickUtil.getArrayIndex(maxIndex, tick_spacing);
  const tickArrayMapAddress = PDAUtil.getTickArrayMapPDA(
    programId,
    clmmpool
  ).publicKey;

  await ctx.fetcher.refreshAll();
  const map = await ctx.fetcher.getTickArrayMap(tickArrayMapAddress);

  const tickArrayAddresses = [];
  for (let i = 0; i < maxTickArrayIndex; i++) {
    if (map?.bitmap[i] && map?.bitmap[i] !== 0) {
      for (let j = 0; j < 8; j++) {
        if ((map.bitmap[i]! & (1 << j)) !== 0) {
          const tickArrayAddress = PDAUtil.getTickArrayPDA(
            programId,
            clmmpool,
            i * 8 + j
          ).publicKey;
          tickArrayAddresses.push(tickArrayAddress);
        }
      }
    }
  }

  const ticks: TickData[] = [];
  for (let i = 0; i < tickArrayAddresses.length; i++) {
    const arrayAddress = tickArrayAddresses[i];
    if (arrayAddress) {
      await ctx.fetcher.refreshAll();
      const ticksInArray = await ctx.fetcher.getTickArray(arrayAddress);
      if (ticksInArray) {
        for (let j = 0; j < ticksInArray.ticks.length; j++) {
          const tick = ticksInArray.ticks[j];
          if (tick) {
            ticks.push(tick);
          }
        }
      }
    }
  }

  return ticks;
}

/**
 * Get all ticks price.
 *
 * @param ticks
 * @returns ticks price
 */
export async function getTicksPrice(ticks: TickData[]) {
  const prices = [];
  for (let i = 0; i < ticks.length; i++) {
    const tick = ticks[i];
    if (!tick!.isInitialized) {
      throw new Error(`tick ${i} is not initialized`);
    }
    prices.push(tick!.sqrtPrice.mul(tick!.sqrtPrice));
  }
  return prices;
}

/**
 * Get nearest tick by current tick.
 *
 * @param tickIndex
 * @param tickSpacing
 * @returns
 */
export function getNearestTickByCurrentTick(
  tickIndex: number,
  tickSpacing: number
): number {
  const mod = Math.abs(tickIndex) % tickSpacing;
  if (tickIndex > 0) {
    if (mod > tickSpacing / 2) {
      return tickIndex + tickSpacing - mod;
    } else {
      return tickIndex - mod;
    }
  } else {
    if (mod > tickSpacing / 2) {
      return tickIndex - tickSpacing + mod;
    } else {
      return tickIndex + mod;
    }
  }
}
