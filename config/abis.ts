import { parseAbi } from "viem";

/**
 * ABIs.
 *
 * PROVENANCE MATTERS HERE. The core vibe/vibe contracts are NOT source-verified
 * on the explorer: Blockscout returns bytecode only. There is no published ABI,
 * no npm package, and the repository the app's own docs page links
 * (github.com/vibeforge1111/project-S) returns HTTP 404.
 *
 * So these fragments come from two places:
 *   1. the operator's public frontend bundle (/static-v2/abis-<hash>.js), and
 *   2. PUSH4 selector extraction from deployed runtime bytecode, resolved
 *      against 4byte.directory and then confirmed with a live eth_call.
 *
 * Anything in group (2) is flagged inline. The bundle URL hash rotates on every
 * deploy, so (1) is not a stable source either.
 */

/** Factory events. All three generations emit ABI-compatible versions. */
export const FACTORY_EVENTS = parseAbi([
  "event TokenLaunched(uint256 indexed launchId, address indexed token, address indexed curve, address creator, address creatorFeeRecipient, address creatorVault, uint256 initialBuy, uint256 initialTokensBought, uint16 metadataSchemaVersion, bytes32 metadataDigest, string metadataURI)",
  "event TokenLaunchedQuoted(uint256 indexed launchId, address indexed token, address indexed curve, address creator, address creatorFeeRecipient, address creatorVault, address quoteCurrency, uint256 initialBuy, uint256 initialTokensBought, uint16 metadataSchemaVersion, bytes32 metadataDigest, string metadataURI)",
  "event LaunchFeesClaimed(address indexed treasury, uint256 amount)",
]);

/** Curve events. Bought/Sold decode confirmed against live logs. */
export const CURVE_EVENTS = parseAbi([
  "event Bought(address indexed buyer, address indexed recipient, uint256 grossEthUsed, uint256 curveQuote, uint256 tokenAmount, uint256 creatorFee, uint256 protocolFee)",
  "event Sold(address indexed seller, uint256 tokenAmount, uint256 grossCurveQuote, uint256 ethReceived, uint256 creatorFee, uint256 protocolFee)",
  "event CurveCompleted(uint256 netEthReserve, uint256 timestamp)",
  "event Graduated(bytes32 indexed poolId, uint256 ethAmount, uint256 tokenAmount)",
  "event CreatorFeesForwarded(address indexed vault, uint256 amount)",
]);

export const ERC20_EVENTS = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export const FACTORY_READS = parseAbi([
  "function launchCount() view returns (uint256)",
  "function curveAt(uint256 launchId) view returns (address)",
  "function launchIdOfToken(address token) view returns (uint256)",
  "function metadataAt(uint256 launchId) view returns (bytes32 digest, string uri)",
  "function isSeedifyToken(address token) view returns (bool)",
  "function isSeedifyCurve(address curve) view returns (bool)",
  "function protocolTreasury() view returns (address)",
  "function graduationAdapter() view returns (address)",
  "function launchFeesAccrued() view returns (uint256)",
  "function LAUNCH_FEE() view returns (uint256)",
  "function INITIAL_VIRTUAL_ETH_RESERVE() view returns (uint256)",
  "function NET_GRADUATION_TARGET() view returns (uint256)",
  "function METADATA_SCHEMA_VERSION() view returns (uint16)",
  "function MAX_METADATA_URI_LENGTH() view returns (uint256)",
  // Selector-derived (0x...): absent from the shipped frontend ABI.
  "function quoteRegistry() view returns (address)",
]);

export const CURVE_READS = parseAbi([
  "function token() view returns (address)",
  "function creatorVault() view returns (address)",
  "function quoteCurrency() view returns (address)",
  "function launchTimestamp() view returns (uint256)",
  "function virtualEthReserve() view returns (uint256)",
  "function virtualTokenReserve() view returns (uint256)",
  "function realEthReserve() view returns (uint256)",
  "function curveTokensRemaining() view returns (uint256)",
  "function tokensSoldFromCurve() view returns (uint256)",
  "function curveTokensBought(address wallet) view returns (uint256)",
  "function creatorFeesAccrued() view returns (uint256)",
  "function protocolFeesAccrued() view returns (uint256)",
  "function complete() view returns (bool)",
  "function graduated() view returns (bool)",
  "function graduatedPoolId() view returns (bytes32)",
  "function spotPriceWad() view returns (uint256)",
  "function fdvWei() view returns (uint256)",
  "function quoteBuy(uint256 grossEth) view returns (uint256 tokenAmount, uint256 grossEthUsed, uint256 curveQuote, uint256 totalFee, uint256 refund)",
  "function quoteSell(uint256 tokenAmount) view returns (uint256 ethReceived, uint256 grossCurveQuote, uint256 totalFee)",
  // Selector-derived, CONFIRMED by live eth_call. Absent from the shipped ABI.
  "function TOTAL_FEE_BPS() view returns (uint256)",
  "function BPS_DENOMINATOR() view returns (uint256)",
  "function TOTAL_SUPPLY() view returns (uint256)",
]);

export const TOKEN_READS = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function curve() view returns (address)",
  // The single most consequential non-standard member on the platform.
  "function transfersUnlocked() view returns (bool)",
]);

export const QUOTE_REGISTRY_READS = parseAbi([
  "function quoteEconomics(address quote) view returns (uint256 initialVirtualEthReserve, uint256 netGraduationTarget, uint256 launchFee, bool registered)",
  "function maxCrank(address quote) view returns (uint256)",
  // Selector-derived. The stock-pair gate: resolves to the ProtocolTreasury.
  "function admin() view returns (address)",
]);

export const TREASURY_READS = parseAbi([
  "function buybackBalance() view returns (uint256)",
  "function treasuryClaimable() view returns (uint256)",
  "function buybackExecutor() view returns (address)",
  "function treasury() view returns (address)",
  "function BURN_ADDRESS() view returns (address)",
]);

/**
 * ERC-8056 scaled-UI interface, for stock-token-shaped quote assets.
 * The only registered quote asset is a MOCK that implements this shape; no real
 * Robinhood Stock Token exists on testnet.
 */
export const ERC8056_READS = parseAbi([
  "function uiMultiplier() view returns (uint256)",
  "function newUIMultiplier() view returns (uint256)",
  "function effectiveAt() view returns (uint256)",
  "function hasPendingUIMultiplierUpdate() view returns (bool)",
  "function paused() view returns (bool)",
  "function oraclePaused() view returns (bool)",
]);
