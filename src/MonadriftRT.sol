// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title MonadriftRT — escrow, checkpoints and settlement for the real-time racer.
/// @notice The driving happens off chain (20 Hz). This contract holds the entry
/// fees, fixes the track seed before the roster is final (commit), timestamps a
/// hash chain of the race while it runs (Checkpoint events), publishes the seed and
/// a replay digest at the end, and pays out. It does NOT re-run the sim: the
/// operator posts the ranking and anyone can check it off chain with
/// `node sim/verify.js` against the Checkpoint events. See docs/REALTIME_PLAN.md §3.
///
/// Money is pull-based: settle/cancel only credit `owed[]`, players `claim()`.
/// A payout address that reverts can therefore never block a race, and settle's
/// gas is a handful of SSTOREs regardless of what the winners are.
contract MonadriftRT {
    enum Mode { HUMAN_ONLY, AGENT_ONLY, SHOWCASE_MIXED }
    // COMMITTED means "lobby closed, race running". The plan listed a separate RUNNING
    // phase, but nothing on chain distinguishes the two, so it is not modelled.
    enum Phase { LOBBY, COMMITTED, SETTLED, CANCELLED }

    struct Race {
        Mode mode;
        Phase phase;
        uint8 maxPlayers;
        uint64 createdAt;
        uint64 startedAt;
        uint256 entryFee;
        uint256 pot;
        bytes32 commitHash;
        address[] players;
    }

    uint256 public constant FEE_BPS = 100; // 1%
    uint256 public constant MIN_PLAYERS = 2;
    uint256 public constant MAX_PLAYERS = 12;
    uint256 public constant LOBBY_TIMEOUT = 1 hours;
    uint256 public constant RESULT_TIMEOUT = 10 minutes; // from commitSeed, with no settle

    address public immutable operator;
    address public immutable treasury;

    uint256 public raceCount;
    mapping(uint256 => Race) private races;
    mapping(uint256 => mapping(address => bool)) public joined;
    mapping(uint256 => mapping(address => address)) public payoutTo;
    mapping(address => uint256) public owed;

    event RaceCreated(uint256 indexed raceId, Mode mode, uint256 entryFee, uint8 maxPlayers);
    event Joined(uint256 indexed raceId, address indexed player, address payoutTo);
    event Committed(uint256 indexed raceId, bytes32 commitHash);
    /// worldHash is the CHAINED hash h_i = keccak(h_{i-1} || worldHash_i), so any one
    /// late checkpoint pins the whole history before it.
    event Checkpoint(uint256 indexed raceId, uint32 index, bytes32 worldHash);
    event Settled(uint256 indexed raceId, uint256 seed, uint256 salt, address[] winners, bytes32 replayRoot, uint256 fee);
    event Cancelled(uint256 indexed raceId);
    event Claimed(address indexed account, uint256 amount);

    modifier onlyOperator() {
        require(msg.sender == operator, "operator only");
        _;
    }

    constructor(address _treasury, address _operator) {
        require(_treasury != address(0) && _operator != address(0), "zero address");
        treasury = _treasury;
        operator = _operator;
    }

    // ---- lobby ----

    function createRace(Mode mode, uint256 entryFee, uint8 maxPlayers) external onlyOperator returns (uint256 raceId) {
        require(maxPlayers >= MIN_PLAYERS && maxPlayers <= MAX_PLAYERS, "bad maxPlayers");
        raceId = raceCount++;
        Race storage r = races[raceId];
        r.mode = mode;
        r.entryFee = entryFee;
        r.maxPlayers = maxPlayers;
        r.createdAt = uint64(block.timestamp);
        emit RaceCreated(raceId, mode, entryFee, maxPlayers);
    }

    /// @param payout where winnings are credited; lets a backend-derived session key
    /// race while a real wallet gets paid.
    function join(uint256 raceId, address payout) external payable {
        Race storage r = _race(raceId);
        require(r.phase == Phase.LOBBY, "lobby closed");
        require(msg.value == r.entryFee, "wrong entry fee");
        require(!joined[raceId][msg.sender], "already joined");
        require(r.players.length < r.maxPlayers, "race full");
        require(payout != address(0), "zero payout");
        joined[raceId][msg.sender] = true;
        payoutTo[raceId][msg.sender] = payout;
        r.players.push(msg.sender);
        r.pot += msg.value;
        emit Joined(raceId, msg.sender, payout);
    }

    /// Closes the lobby and fixes the track: commitHash = keccak256(abi.encodePacked(seed, salt)).
    /// Committed before the race, revealed at settle, so the operator cannot pick a
    /// track after seeing who joined, and no bot learns the track before the start.
    function commitSeed(uint256 raceId, bytes32 commitHash) external onlyOperator {
        Race storage r = _race(raceId);
        require(r.phase == Phase.LOBBY, "not in lobby");
        require(r.players.length >= MIN_PLAYERS, "need more players");
        r.phase = Phase.COMMITTED;
        r.commitHash = commitHash;
        r.startedAt = uint64(block.timestamp);
        emit Committed(raceId, commitHash);
    }

    // ---- race ----

    /// Event only: no storage write, so a checkpoint every 5 s stays cheap.
    function checkpoint(uint256 raceId, uint32 index, bytes32 worldHash) external onlyOperator {
        require(_race(raceId).phase == Phase.COMMITTED, "not running");
        emit Checkpoint(raceId, index, worldHash);
    }

    /// @param winners finishing order, best first, at most 3, all joined and distinct.
    /// Empty list = nobody finished: everyone is refunded, no fee.
    function settle(uint256 raceId, uint256 seed, uint256 salt, address[] calldata winners, bytes32 replayRoot) external onlyOperator {
        Race storage r = _race(raceId);
        require(r.phase == Phase.COMMITTED, "not running");
        require(keccak256(abi.encodePacked(seed, salt)) == r.commitHash, "reveal mismatch");
        uint256 n = winners.length;
        require(n <= 3, "max 3 winners");
        r.phase = Phase.SETTLED;

        uint256 fee;
        if (n == 0) {
            _refund(raceId, r);
        } else {
            for (uint256 i = 0; i < n; i++) {
                require(joined[raceId][winners[i]], "winner not in race");
                for (uint256 j = 0; j < i; j++) require(winners[j] != winners[i], "duplicate winner");
            }
            fee = (r.pot * FEE_BPS) / 10_000;
            owed[treasury] += fee;
            _pay(raceId, winners, r.pot - fee);
        }
        emit Settled(raceId, seed, salt, winners, replayRoot, fee);
    }

    /// 50/30/20 renormalised over the actual winners: 1 -> 100, 2 -> 62.5/37.5.
    /// The last winner takes the remainder so no wei is ever stranded.
    function _pay(uint256 raceId, address[] calldata winners, uint256 prize) internal {
        uint256 n = winners.length;
        uint256 paid;
        for (uint256 i = 0; i < n; i++) {
            uint256 share;
            if (i == n - 1) share = prize - paid;
            else if (n == 2) share = (prize * 5) / 8;
            else share = i == 0 ? prize / 2 : (prize * 3) / 10;
            paid += share;
            owed[payoutTo[raceId][winners[i]]] += share;
        }
    }

    /// Anyone once a timeout has passed (operator disappeared); the operator at any
    /// time before settlement. Refund-only, so the operator gains nothing by it.
    function cancel(uint256 raceId) external {
        Race storage r = _race(raceId);
        require(r.phase == Phase.LOBBY || r.phase == Phase.COMMITTED, "already ended");
        if (msg.sender != operator) {
            if (r.phase == Phase.LOBBY) require(block.timestamp >= r.createdAt + LOBBY_TIMEOUT, "too early");
            else require(block.timestamp >= r.startedAt + RESULT_TIMEOUT, "too early");
        }
        r.phase = Phase.CANCELLED;
        _refund(raceId, r);
        emit Cancelled(raceId);
    }

    function claim() external returns (uint256 amount) {
        amount = owed[msg.sender];
        require(amount > 0, "nothing to claim");
        owed[msg.sender] = 0; // zero first: reentrancy into claim() finds nothing
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "transfer failed");
        emit Claimed(msg.sender, amount);
    }

    // ---- views ----

    function getRace(uint256 raceId) external view returns (Mode mode, Phase phase, uint256 entryFee, uint8 maxPlayers, uint256 pot, bytes32 commitHash, uint64 createdAt, uint64 startedAt, address[] memory players) {
        Race storage r = _race(raceId);
        return (r.mode, r.phase, r.entryFee, r.maxPlayers, r.pot, r.commitHash, r.createdAt, r.startedAt, r.players);
    }

    function getPlayers(uint256 raceId) external view returns (address[] memory) {
        return _race(raceId).players;
    }

    // ---- internal ----

    function _race(uint256 raceId) internal view returns (Race storage) {
        require(raceId < raceCount, "no such race");
        return races[raceId];
    }

    function _refund(uint256 raceId, Race storage r) internal {
        uint256 len = r.players.length;
        for (uint256 i = 0; i < len; i++) {
            address p = r.players[i];
            owed[payoutTo[raceId][p]] += r.entryFee;
        }
    }
}
