import { ComputeBudgetProgram, Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import { Address } from "@project-serum/anchor";
import { TransactionEnvelope } from "@cremafinance/solana-contrib";
import { getOrCreateATA, getOrCreateATAs, ZERO } from "@cremafinance/token-utils"
import type { Clmmpool } from "../clmmpool-client";
import type { ClmmpoolContext } from "../context";
import type { AccountFetcher } from "../network";
import type { ClmmpoolData, DecreaseLiquidityInput, IncreaseLiquidityInput, TickData, TokenAccountInfo } from "../types";
import { getTokenVaultAccountInfos } from "./util";
import invariant from "tiny-invariant";
import { PDAUtil } from "../utils/pda";
import BN from "bn.js";
import {
  ClmmpoolIx, SwapInput
} from "../ix";
import { POSITION_NFT_UPDATE_AUTHORITY, TICK_ARRAY_SIZE,CLMMPOOL_PROGRAM_ID, ZERO_BN } from "../types/constants";
import { AddressUtil } from "../utils/address-util"

import { TokenUtil } from "../utils/token-utils"
import { TickArray, TokenInfo } from '../types/client-types';
import { TickArrayUtil, TickUtil } from "../utils/tick";
import { Decimal } from "decimal.js";
import { computeSwap, getSwapTickArrays } from "../math/clmm";
import type { u64 } from "@solana/spl-token";
import { getAllPositionsFromPool, MathUtil, SwapUtils } from "../math";
import { listRewarderInfosFromClmmpool, emissionsEveryDay } from "../utils";

export const INIT_KEY = new PublicKey("11111111111111111111111111111111");
export interface PendingOpenPosition {
  positionId: PublicKey;
  positionAccount: PublicKey;
  positionsKey: PublicKey;
  tx: TransactionEnvelope;
}

 export type SwapQuoteParam = {
  clmmpoolData: ClmmpoolData;
  tokenAmount: u64;
  sqrtPriceLimit: BN;
  aToB: boolean;
  byAmountIn: boolean;
  tickArrays: TickArray[];
};

export type SwapQuote = {
  estimatedAmountIn: u64;
  estimatedAmountOut: u64;
  estimatedEndSqrtPrice: BN;
  estimatedFeeAmount: u64;
  isExceed: boolean;
  extraComputeLimit: number;
  aToB: boolean;
  byAmountIn: boolean;
  amount: BN;
}

export class ClmmpoolImpl implements Clmmpool {
  tickArrays: TickArray[];
  private data: ClmmpoolData;
  private ticks: TickData[];
  private refreshTime: Date;
  private growthGlobal: BN[];
  constructor( 
    readonly ctx: ClmmpoolContext,
    readonly fetcher: AccountFetcher,
    readonly address: PublicKey,
    readonly tokenAInfo: TokenInfo,
    readonly tokenBInfo: TokenInfo,
    private tokenVaultAInfo: TokenAccountInfo,
    private tokenVaultBInfo: TokenAccountInfo,
    data: ClmmpoolData
  ) {
    this.data = data;
    this.ticks = [];
    this.tickArrays = [];
    this.refreshTime = new Date();
    this.growthGlobal = [new BN(0), new BN(0), new BN(0)];
  }

  getAddress(): PublicKey {
    return this.address;
  }

  getData(): ClmmpoolData {
    return this.data;
  }

  getTokenAInfo(): TokenInfo {
    return this.tokenAInfo;
  }

  getTokenBInfo(): TokenInfo {
    return this.tokenBInfo;
  }

  getTokenVaultAInfo(): TokenAccountInfo {
    return this.tokenVaultAInfo;
  }

  getTokenVaultBInfo(): TokenAccountInfo {
    return this.tokenVaultBInfo;
  }

  async refreshData() {
    await this.refresh();
    return this.data;
  }

  async openPosition(
    tickLower: number,
    tickUpper: number,
    liquidityInput: IncreaseLiquidityInput,
    isAFixed: boolean
  ): Promise<TransactionEnvelope> {
    await this.refresh();
    return this.getOpenPositionTx(tickLower, tickUpper, liquidityInput, isAFixed)
  }

  private async getOpenPositionTx(tickLower: number,
    tickUpper: number,
    liquidityInput: IncreaseLiquidityInput,
    isAFixed: boolean
  ): Promise<TransactionEnvelope> {
    invariant(tickLower <= tickUpper, "The tickLower must be less than tickUpper");
    invariant(TickUtil.checkTickInBounds(tickLower), "tickLower is out of bounds.");
    invariant(TickUtil.checkTickInBounds(tickUpper), "tickUpper is out of bounds.");
    const { liquidityAmount: liquidity, tokenMaxA, tokenMaxB } = liquidityInput
    invariant(liquidity.gt(new BN(0)), "liquidity must be greater than zero");

    const clmmpool = await this.fetcher.getPool(this.address, false);
    if (!clmmpool) {
      throw new Error(`clmmpool not found: ${this.address.toBase58()}`);
    }
    invariant(
      TickUtil.isTickInitializable(tickLower, clmmpool.tickSpacing),
      `lower tick ${tickLower} is not an initializable tick for tick-spacing ${clmmpool.tickSpacing}`
    );
    invariant(
      TickUtil.isTickInitializable(tickUpper, clmmpool.tickSpacing),
      `upper tick ${tickUpper} is not an initializable tick for tick-spacing ${clmmpool.tickSpacing}`
    );
    const instructions: TransactionInstruction[] = [];

    // Generate create position nft token instructions
    const positionNftMint = Keypair.generate();

    const positionPda = PDAUtil.getPositionPDA(this.ctx.program.programId, positionNftMint.publicKey);
    const metadataPda = PDAUtil.getPositionMetadataPDA(positionNftMint.publicKey);

    const positionAta = await getOrCreateATAs({
      provider: this.ctx.provider, mints: {
        positionNftMint: positionNftMint.publicKey
      }
    });

    const positionEdition = PDAUtil.getPositionEditionPDA(positionNftMint.publicKey).publicKey
    const openPositionParams = {
      tickLowerIndex: tickLower,
      tickUpperIndex: tickUpper,
      owner: this.ctx.wallet.publicKey,
      clmmpool: this.getAddress(),
      position: positionPda.publicKey,
      positionNftMint: positionNftMint.publicKey,
      positionMetadataAccount: metadataPda.publicKey,
      positionNftUpdateAuthority: POSITION_NFT_UPDATE_AUTHORITY,
      positionAta: positionAta.accounts.positionNftMint,
      positionEdition
    }

    const positionIx = ClmmpoolIx.openPositionIx(this.ctx.program, openPositionParams)
    instructions.push(positionIx)

    // add liquidity

    const accountATAs = await getOrCreateATAs({
      provider: this.ctx.provider,
      mints: {
        tokenA: clmmpool.tokenA,
        tokenB: clmmpool.tokenB
      },
      owner: this.ctx.provider.wallet.publicKey
    })
    // instructions.push(...accountATAs.instructions)

    const tickArrayLower = PDAUtil.getTickArrayPDA(
      this.ctx.program.programId,
      this.address,
      TickUtil.getArrayIndex(tickLower, clmmpool.tickSpacing)
    ).publicKey;
    const tickArrayUpper = PDAUtil.getTickArrayPDA(
      this.ctx.program.programId,
      this.address,
      TickUtil.getArrayIndex(tickUpper, clmmpool.tickSpacing)
    ).publicKey;

    const tickArrayInstructions = []

    const tickArrayMap = PDAUtil.getTickArrayMapPDA(this.ctx.program.programId, this.address).publicKey
    const isTickArrayMapInit = await TickArrayUtil.isTickArrayInitialized(tickArrayMap, this.ctx.provider)
    if (!isTickArrayMapInit) {
      const initTickArrayMapIx = ClmmpoolIx.createTickArrayMapIx(this.ctx.program, {
        payer: this.ctx.wallet.publicKey,
        clmmpool: this.address,
        tickArrayMap: tickArrayMap
      })
      tickArrayInstructions.push(initTickArrayMapIx)
    }



    const isTickLowerArrayInit = await TickArrayUtil.isTickArrayInitialized(tickArrayLower, this.ctx.provider)
    if (!isTickLowerArrayInit) {
      const initTickArrayIx = await this.initTickArrayForTicks(tickLower, tickArrayLower)
      tickArrayInstructions.push(...initTickArrayIx.instructions)
    }


    if (tickArrayLower.toBase58() !== tickArrayUpper.toBase58()) {
      const isTickUpperArrayInit = await TickArrayUtil.isTickArrayInitialized(tickArrayUpper, this.ctx.provider)
      if (!isTickUpperArrayInit) {
        const initTickArrayIx = await this.initTickArrayForTicks(tickUpper, tickArrayUpper)
        tickArrayInstructions.push(...initTickArrayIx.instructions)
      }
    }
    if (tickArrayInstructions && tickArrayInstructions.length > 0) {
      instructions.push(...tickArrayInstructions)
    }

    const liquidityInputWithFixedToken = {
      tokenA: tokenMaxA,
      tokenB: tokenMaxB,
      isAFixed
    }
    const increaseLiquidityParams = {
      liquidityInputWithFixedToken,
      owner: this.ctx.wallet.publicKey,
      clmmpool: this.getAddress(),
      position: positionPda.publicKey,
      positionAta: positionAta.accounts.positionNftMint,
      tokenAAta: accountATAs.accounts.tokenA,
      tokenBAta: accountATAs.accounts.tokenB,
      tokenAVault: clmmpool.tokenAVault,
      tokenBVault: clmmpool.tokenBVault,
      tickArrayLower,
      tickArrayUpper,
      tickArrayMap: tickArrayMap
    }
    const liquidityIx = ClmmpoolIx.increaseLiquidityWithFixedTokenIx(this.ctx.program, increaseLiquidityParams);
    instructions.push(liquidityIx)

    if (
      clmmpool.tokenA.equals(NATIVE_MINT) &&
      tokenMaxA.gt(new BN(0))
    ) {
      const wrapSOLInstructions = await TokenUtil.wrapSOL(this.ctx.provider, new Decimal(tokenMaxA.toString()));
      instructions.unshift(...wrapSOLInstructions.instructions);
      const unwrapSOLInstructions = await TokenUtil.unwrapSOL(this.ctx.provider, accountATAs.accounts.tokenA);
      instructions.push(...unwrapSOLInstructions.instructions);
    }
    if (
      clmmpool.tokenB.equals(NATIVE_MINT) &&
      tokenMaxB.gt(new BN(0))
    ) {
      const wrapSOLInstructions = await TokenUtil.wrapSOL(this.ctx.provider, new Decimal(tokenMaxB.toString()));
      instructions.unshift(...wrapSOLInstructions.instructions);
      const unwrapSOLInstructions = await TokenUtil.unwrapSOL(this.ctx.provider, accountATAs.accounts.tokenB);
      instructions.push(...unwrapSOLInstructions.instructions);
    }

    instructions.unshift(...accountATAs.instructions)

    return new TransactionEnvelope(this.ctx.provider, instructions, [positionNftMint])

  }

  async closePosition(liquidityInput: DecreaseLiquidityInput, positionId: PublicKey, positionNftMint: PublicKey, swapKey: PublicKey) {
    await this.refresh()
    return this.getClosePositionIx(liquidityInput, positionId, positionNftMint, swapKey)
  }

  private async getClosePositionIx(liquidityInput: DecreaseLiquidityInput, positionId: PublicKey, positionNftMint: PublicKey, swapKey: PublicKey) {
    const position = await this.fetcher.getPosition(positionId)
    if (!position) {
      throw new Error(`Position not found: ${positionId.toBase58()}`);
    }

    const clmmpool = await this.fetcher.getPool(swapKey, true);
    if (!clmmpool) {
      throw new Error("Unable to fetch clmmpool for this position.");
    }

    const wallet = this.ctx.provider.wallet.publicKey
    const positionAta = await getOrCreateATAs({ provider: this.ctx.provider, mints: { positionAddress: positionNftMint }, owner: wallet });
    const accountATAs = await getOrCreateATAs({
      provider: this.ctx.provider,
      mints: {
        tokenA: clmmpool.tokenA,
        tokenB: clmmpool.tokenB
      },
      owner: wallet
    })
    const decreaseLiquidityIx = new TransactionEnvelope(this.ctx.provider, [ClmmpoolIx.decreaseLiquidityIx(this.ctx.program, {
      liquidityInput,
      owner: wallet,
      clmmpool: swapKey,
      position: positionId,
      positionAta: positionAta.accounts.positionAddress,
      tokenAAta: accountATAs.accounts.tokenA,
      tokenBAta: accountATAs.accounts.tokenB,
      tokenAVault: clmmpool.tokenAVault,
      tokenBVault: clmmpool.tokenBVault,
      tickArrayLower: PDAUtil.getTickArrayPDA(
        this.ctx.program.programId,
        swapKey,
        TickUtil.getArrayIndex(position.tickLowerIndex, clmmpool.tickSpacing)
      ).publicKey,
      tickArrayUpper: PDAUtil.getTickArrayPDA(
        this.ctx.program.programId,
        swapKey,
        TickUtil.getArrayIndex(position.tickUpperIndex, clmmpool.tickSpacing)
      ).publicKey,
      tickArrayMap: PDAUtil.getTickArrayMapPDA(
        this.ctx.program.programId,
        swapKey,
      ).publicKey
    })])

    const tickUpper = position.tickUpperIndex 
    const tickLower = position.tickLowerIndex
    const tickArrayLower = PDAUtil.getTickArrayPDA(
      this.ctx.program.programId,
      swapKey,
      TickUtil.getArrayIndex(tickLower, clmmpool.tickSpacing)
    ).publicKey;
    const tickArrayUpper = PDAUtil.getTickArrayPDA(
      this.ctx.program.programId,
      swapKey,
      TickUtil.getArrayIndex(tickUpper, clmmpool.tickSpacing)
    ).publicKey;

    const metadataPda = PDAUtil.getPositionMetadataPDA(positionNftMint);

    const cliamIx = new TransactionEnvelope(this.ctx.provider, [
      ClmmpoolIx.collectFeeIx(this.ctx.program, {
        owner: wallet,
        clmmpool: swapKey,
        position: positionId,
        positionAta: positionAta.accounts.positionAddress,
        tokenAAta: accountATAs.accounts.tokenA,
        tokenBAta: accountATAs.accounts.tokenB,
        tokenAVault: clmmpool.tokenAVault,
        tokenBVault: clmmpool.tokenBVault,
        tickArrayLower,
        tickArrayUpper
      })]
    )

    const collectRewarderIxResult = [];
    const collectRewarderArr:string[] = []

    for (let i = 0; i < 3; i++) {
      // @ts-ignore
      const rewarderAta = await getOrCreateATAs({ provider: this.ctx.provider, mints:{ address:clmmpool.rewarderInfos[i].mint}, owner: wallet });
      // @ts-ignore
      if(!PublicKey.default.equals(clmmpool.rewarderInfos[i].mint)){

        if (rewarderAta && rewarderAta.instructions&&!collectRewarderArr.includes(rewarderAta.accounts.address.toBase58())) {
          collectRewarderArr.push(rewarderAta.accounts.address.toBase58())
          collectRewarderIxResult.unshift(...rewarderAta.instructions)
        }
        const collectRewarderIx =
          ClmmpoolIx.collectRewarderIx(this.ctx.program, {
            owner: wallet,
            clmmpool: swapKey,
            position: positionId,
            positionAta: positionAta.accounts.positionAddress,
            rewarderAta: rewarderAta.accounts.address,
            // @ts-ignore
            mintWrapper: clmmpool.rewarderInfos[i].mintWrapper,
            // @ts-ignore
            minter: clmmpool.rewarderInfos[i].minter,
            // @ts-ignore
            rewardsTokenMint: clmmpool.rewarderInfos[i].mint,
            tickArrayLower,
            tickArrayUpper,
            rewarderIndex:i
          }
          )
          collectRewarderIxResult.push(collectRewarderIx)
      }
    }

    const instructions= []

    if (
      clmmpool.tokenA.equals(NATIVE_MINT)
    ) {
      const unwrapSOLInstructions = await TokenUtil.unwrapSOL(this.ctx.provider, accountATAs.accounts.tokenA);
      instructions.push(...unwrapSOLInstructions.instructions);
    }
    if (
      clmmpool.tokenB.equals(NATIVE_MINT)
    ) {
      const unwrapSOLInstructions = await TokenUtil.unwrapSOL(this.ctx.provider, accountATAs.accounts.tokenB);
      instructions.push(...unwrapSOLInstructions.instructions);
    }
    
    const positionEdition = PDAUtil.getPositionEditionPDA(positionNftMint).publicKey

    const closePositionIx = new TransactionEnvelope(this.ctx.provider, [
      ...accountATAs.instructions,
      ...decreaseLiquidityIx.instructions,
      ...collectRewarderIxResult,
      ...cliamIx.instructions,
      
      ClmmpoolIx.removePositionIx(this.ctx.program, {
        owner: wallet,
        position: positionId,
        positionNftMint: positionNftMint,
        positionAta: positionAta.accounts.positionAddress,
        positionMetadataAccount: metadataPda.publicKey,
        positionEdition
      }),
      ...instructions
    ])
    return closePositionIx
  }

  async initTickArrayForTicks(arrayIndex: number, tickArrayPda: PublicKey) {
    await this.refresh();
    return this.getInitTickArrayForTicks(arrayIndex, tickArrayPda)
  }

  private async getInitTickArrayForTicks(arrayIndex: number, tickArrayPda: PublicKey) {
    const createTickArrayIx = new TransactionEnvelope(this.ctx.provider, [ClmmpoolIx.createTickArrayIx(this.ctx.program, {
      arrayIndex: TickUtil.getArrayIndex(arrayIndex, this.data.tickSpacing),
      payer: this.ctx.provider.wallet.publicKey,
      clmmpool: this.address,
      tickArray: tickArrayPda
    })])
    return createTickArrayIx
  }

  async createTickArrayRange(
    a2b: boolean
  ): Promise<PublicKey[]> {
    const clmmpool = this.getAddress();
    const tickArrayMapAddr = PDAUtil.getTickArrayMapPDA(
      CLMMPOOL_PROGRAM_ID,
      clmmpool
    ).publicKey;
    const tickArrayMap = await this.fetcher.getTickArrayMap(
      tickArrayMapAddr,
      true
    );

    const startArrayIndex = TickUtil.getArrayIndex(this.data.currentTickIndex, this.data.tickSpacing);
    const tickArrays = getSwapTickArrays(clmmpool, a2b, startArrayIndex, tickArrayMap!);
    return tickArrays;
  }

  getAllTicksFromTickArrays(
    a2b: boolean,
  ): TickData[] {
    const ticks: TickData[] = [];
    for (let i = 0; i < this.tickArrays.length; i++) {
      const tickArray: any = this.tickArrays[i];
      if (a2b) {
        for (let j = TICK_ARRAY_SIZE - 1; j >= 0; j--) {
          if (tickArray.data.ticks[j].isInitialized) {
            ticks.push(tickArray.data.ticks[j]);
          }
        }
      } else {
        for (let j = 0; j < TICK_ARRAY_SIZE; j++) {
          if (tickArray.data.ticks[j].isInitialized) {
            ticks.push(tickArray.data.ticks[j]);
          }
        }
      }
    }

    return ticks;
  }

  async simulateSwap(a2b: boolean, byAmountIn: boolean, amount: BN): Promise<SwapQuote> {
    const tickArraysAddr = await this.createTickArrayRange(a2b);

    //If interval time greater than 5 s, then refresh.
    const nowTime = new Date();
    const refreshTimeInterval = nowTime.getTime() - this.refreshTime.getTime();
    const refresh = refreshTimeInterval > 1000 * 5 ? true : false;
    this.refreshTime = refresh ? nowTime : this.refreshTime;

    const tickArrays = await this.fetcher.listTickArrays(tickArraysAddr, refresh);
    for (let i = 0; i < tickArrays.length; i++) {
      this.tickArrays.push({
        address: tickArraysAddr[i],
        data: tickArrays[i],
      })
    }

    this.ticks = this.getAllTicksFromTickArrays(a2b);

    const swapResult = computeSwap(a2b, byAmountIn, amount, this.data, this.ticks);

    let isExceed = false;
    if (byAmountIn) {
      isExceed = swapResult.amountIn.lt(amount);
    } else {
      isExceed = swapResult.amountOut.lt(amount);
    }

    let extraComputeLimit = 0;
    if (swapResult.crossTickNum > 6 && swapResult.crossTickNum < 40) {
      extraComputeLimit = 22000 * (swapResult.crossTickNum - 6);
    }

    if (swapResult.crossTickNum > 40) {
      isExceed = true;
    }

    return {
      estimatedAmountIn: swapResult.amountIn,
      estimatedAmountOut: swapResult.amountOut,
      estimatedEndSqrtPrice: swapResult.nextSqrtPrice,
      estimatedFeeAmount: swapResult.feeAmount,
      isExceed,
      extraComputeLimit,
      amount,
      aToB: a2b,
      byAmountIn,
    }
  }

  // `swap` provide an interface to generate a transaction of swap .
  // extra_compute_limit: default is false, if you control compute unit by your self, you can ignore it.
  async swap(quote: SwapInput, sourceWallet?: Address, extra_compute_limit?: boolean): Promise<TransactionEnvelope> {
    const sourceWalletKey = sourceWallet
      ? AddressUtil.toPubKey(sourceWallet)
      : this.ctx.wallet.publicKey;

    const instructions: TransactionInstruction[] = [];
    const clmmpool = this.data;
    const accountATAs = await getOrCreateATAs({
      provider: this.ctx.provider,
      mints: {
        tokenA: clmmpool.tokenA,
        tokenB: clmmpool.tokenB
      },
      owner: sourceWalletKey
    })
    instructions.push(...accountATAs.instructions);
    const swapTx = await this.getSwapTx(quote, sourceWalletKey, accountATAs.accounts.tokenA, accountATAs.accounts.tokenB);
    
    if (extra_compute_limit === true) {
      // Use new compute limit replace default limit
      if (quote.extraComputeLimit !== 0) {
        const extraComputeLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ 
          units: 200000 + quote.extraComputeLimit,
        });  
        instructions.push(extraComputeLimitIx)
      }
    }

    swapTx.instructions.unshift(...instructions);

    return swapTx;
  }

  private async getSwapTx(input: SwapInput, wallet: PublicKey, accountA: PublicKey, accountB: PublicKey): Promise<TransactionEnvelope> {
    const clmmpool = this.data;

    const tickArrayMap = PDAUtil.getTickArrayMapPDA(this.ctx.program.programId, this.address)

    const sqrtPriceLimit = SwapUtils.getDefaultSqrtPriceLimit(input.aToB)
    const remainAccount = await this.createTickArrayRange(input.aToB)
    
    const tx = new TransactionEnvelope(this.ctx.provider, [ClmmpoolIx.swapIx(this.ctx.program, {
      aToB: input.aToB,
      byAmountIn: input.byAmountIn,
      amount: new BN(input.amount.toString()),
      amountLimit: new BN(input.amountLimit.toString()),
      sqrtPriceLimit,
      clmmpool: this.address,
      tokenA: clmmpool.tokenA,
      tokenB: clmmpool.tokenB,
      accountA,
      accountB,
      tokenAVault: clmmpool.tokenAVault,
      tokenBVault: clmmpool.tokenBVault,
      tickArrayMap: tickArrayMap.publicKey,
      owner: wallet,
      tickArrays: remainAccount,
      clmmConfig: PDAUtil.getClmmConfigPDA(this.ctx.program.programId).publicKey
    })])
    const amount = new Decimal(input.amount.toString())
    const amountLimit = new Decimal(input.amountLimit.toString())

    if (clmmpool.tokenA.equals(NATIVE_MINT)) {
      
      if (input.aToB) {
        const wrapSOLTx = await TokenUtil.wrapSOL(this.ctx.provider, input.byAmountIn ? amount : amountLimit);
        tx.instructions.unshift(...wrapSOLTx.instructions);
        const unwrapSOLTx = await TokenUtil.unwrapSOL(this.ctx.provider, accountA)
        tx.instructions.push(...unwrapSOLTx.instructions);
      } else {
        const unwrapSOLTx = await TokenUtil.unwrapSOL(this.ctx.provider, accountA);
        tx.instructions.push(...unwrapSOLTx.instructions);
      }
    }

    if (clmmpool.tokenB.equals(NATIVE_MINT)) {
      if (input.aToB) {
        const unwrapSOLTx = await TokenUtil.unwrapSOL(this.ctx.provider, accountB);
        tx.instructions.push(...unwrapSOLTx.instructions);
      } else {
        const wrapSOLTx = await TokenUtil.wrapSOL(this.ctx.provider, input.byAmountIn ? amount : amountLimit);
        tx.instructions.unshift(...wrapSOLTx.instructions);
        const unwrapSOLTx = await TokenUtil.unwrapSOL(this.ctx.provider, accountB);
        tx.instructions.push(...unwrapSOLTx.instructions);
      }
    }

    return tx
  }

  async emissionEveryDay() {
    const emissions = await emissionsEveryDay(this.ctx, this.address);
    return emissions;
  }

  async updatePoolRewarder(currentTime: BN) {
    await this.refresh();
    const last_time = this.data.rewarderLastUpdatedTime;
    this.data.rewarderLastUpdatedTime = currentTime;

    if(this.data.liquidity.eq(new BN(0)) || currentTime.eq(last_time)) {
      return;
    }

    const timeDelta = currentTime.div(new BN(1000)).sub(last_time).add(new BN(15));
    const rewarderInfos: any = this.data.rewarderInfos;

    for (let i = 0; i < rewarderInfos.length; i++) {
      const rewarderInfo = rewarderInfos[i];
      if (rewarderInfo.mint === PublicKey.default.toString()) {
        continue;
      }

      const rewarderGrowthDelta =  MathUtil.checkMulDivFloor(timeDelta, rewarderInfo.emissionsPerSecond, this.data.liquidity, 128);
      this.growthGlobal[i] = new BN(rewarderInfo.growthGlobal).add(rewarderGrowthDelta);
    }
  }

  async posRewardersAmount(positionId: PublicKey, refresh: boolean = true, index: number = 0) {
    const currentTime = Date.parse(new Date().toString());
    if(index === 0){
      await this.updatePoolRewarder(new BN(currentTime));
    }

    const position = await this.fetcher.getPosition(positionId, refresh);
    const tickLower = await TickUtil.getTickDataFromIndex(this.fetcher, this.address, this.ctx.program.programId, position!.tickLowerIndex, this.data.tickSpacing);
    const tickUpper = await TickUtil.getTickDataFromIndex(this.fetcher, this.address, this.ctx.program.programId, position!.tickUpperIndex, this.data.tickSpacing);
    const rewardersInside = TickUtil.getRewardInTickRange(this.data, tickLower, tickUpper, position!.tickLowerIndex, position!.tickUpperIndex, this.growthGlobal);

    const growthInside = [];
    const AmountOwed = [];

    let posRewarderInfos: any = position?.rewarderInfos;

    for (let i = 0; i < rewardersInside.length; i++) {
      let posRewarderInfo = posRewarderInfos[i];

      const growthDelta = rewardersInside[i].sub(posRewarderInfo.growthInside);
      const amountOwedDelta = MathUtil.checkMulShiftRight(position!.liquidity, growthDelta, 64, 256);

      growthInside.push(rewardersInside[i]);
      
      AmountOwed.push(new BN(posRewarderInfo.AmountOwed).add(amountOwedDelta));
    }

    return AmountOwed;
  }

  async poolRewardersAmount() {
    const positions = await getAllPositionsFromPool(this.ctx.connection, this.ctx.wallet.publicKey, CLMMPOOL_PROGRAM_ID, this.fetcher, this.address);
    let rewarderAmount = [ZERO_BN, ZERO_BN, ZERO_BN];
    let updatePoolIndex = 0;
    for(let i=0; i<positions.length; i++) {
      for(let j=0; j<3; j++) {
        const posRewarderInfo = await this.posRewardersAmount(positions[i], false, updatePoolIndex);
        rewarderAmount[j] = rewarderAmount[j].add(posRewarderInfo[j]);
        updatePoolIndex+=1
      }
    }

    return rewarderAmount;
  }

  async collectRewarderIx(rewarderIndex: number, positionId: PublicKey): Promise<TransactionEnvelope> {
    const clmmpool = this.data;
    const position = await this.ctx.fetcher.getPosition(positionId, true);
    const positionAta = await getOrCreateATA({provider: this.ctx.provider, mint: position!.positionNftMint, owner: this.ctx.wallet.publicKey});
    
    const lowerArrayIndex = TickUtil.getArrayIndex(position!.tickLowerIndex, clmmpool.tickSpacing);
    const upperArrayIndex = TickUtil.getArrayIndex(position!.tickUpperIndex, clmmpool.tickSpacing);
    const tickArrayLower = PDAUtil.getTickArrayPDA(this.ctx.program.programId, this.address, lowerArrayIndex).publicKey;
    const tickArrayUpper = PDAUtil.getTickArrayPDA(this.ctx.program.programId, this.address, upperArrayIndex).publicKey;

    const rewarderInfos = await listRewarderInfosFromClmmpool(this.ctx, this.address);
    if(rewarderIndex >= rewarderInfos.length) {
      throw new Error('rewarder index is out of range');
    }
    const minter = rewarderInfos[rewarderIndex].minter;
    const mintWrapper = rewarderInfos[rewarderIndex].mintWrapper;
    const rewardsTokenMint = rewarderInfos[rewarderIndex].mint;
    const rewarderAta = await getOrCreateATA({provider: this.ctx.provider, mint: rewardsTokenMint, owner: this.ctx.wallet.publicKey});

    const ixs = [];
    if (rewarderAta.instruction !== null){
      ixs.push(rewarderAta.instruction)
    }
    ixs.push(
      ClmmpoolIx.collectRewarderIx(this.ctx.program, {
        owner: this.ctx.wallet.publicKey,
        clmmpool: this.address,
        position: positionId,
        positionAta: positionAta.address,
        rewarderAta: rewarderAta.address,
        mintWrapper,
        minter,
        rewardsTokenMint,
        tickArrayLower,
        tickArrayUpper,
        rewarderIndex
    }))

    const tx = new TransactionEnvelope(this.ctx.provider, ixs)
    return tx;
  }

  async collectAllRewarderIxs(): Promise<TransactionEnvelope> {
    const positions = await getAllPositionsFromPool(this.ctx.connection, this.ctx.wallet.publicKey, CLMMPOOL_PROGRAM_ID, this.fetcher,this.address);    

    const ixs = [];
    for(let i=0; i<3; i++) {
      const rewarderInfos: any = this.data.rewarderInfos;
      if (rewarderInfos[i].mint.toString() === PublicKey.default.toString()) {
        continue;
      }

      const rewarderAta = await getOrCreateATA({provider: this.ctx.provider, mint: rewarderInfos[i].mint, owner: this.ctx.wallet.publicKey});
      if (rewarderAta.instruction !== null) {
        ixs.push(rewarderAta.instruction);
      }

      for (let j=0; j< positions.length; j++) {
        const ix = (await this.collectRewarderIx(i, positions[j])).instructions;
        ixs.push(ix[ix.length - 1])
      }
    }

    const tx = new TransactionEnvelope(this.ctx.provider, ixs);
    return tx;
  }

  private async refresh() {
    const clmmpool = await this.fetcher.getPool(this.address, true);
    if (clmmpool) {
      // const rewardInfos = await getRewardInfos(this.fetcher, account, true);
      const [tokenVaultAInfo, tokenVaultBInfo] =
        await getTokenVaultAccountInfos(this.fetcher, clmmpool, true);
      this.data = clmmpool;
      if (tokenVaultAInfo) {
        this.tokenVaultAInfo = tokenVaultAInfo;
      }

      if (tokenVaultBInfo) {
        this.tokenVaultBInfo = tokenVaultBInfo;
      }
    }
  }
}
