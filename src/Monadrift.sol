// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Monadrift
/// @notice On-chain checkpoint racer. Track is generated on demand from a
///         commit-reveal seed; only the segment immediately ahead of a
///         player is ever meaningful to compute, which is what actually
///         blocks pre-computation (see PROJECT.md §4), not seed secrecy.
/// @dev Constants below are placeholders — see PROJECT.md §16 "Open decisions".
contract Monadrift {
    // ---- tunables (placeholder values, not balanced yet) ----
    uint16 public constant SEGMENTS_TOTAL = 60;
    uint16 public constant CHECKPOINT_INTERVAL = 10;
    uint8 public constant HP_MAX = 3;
    uint8 public constant MAX_SPEED = 3;
    // A correct move now REWARDS stake instead of costing it (players kept
    // going broke just from playing correctly — MOVE_COST was charged on
    // every move regardless of outcome). Funded from the shared pot
    // (entry fees + accumulated penalties), capped so it can never
    // underflow. Kept small: this is real prize money, and draining it too
    // fast shrinks what's left for the top-3 payout at settle().
    uint256 public constant MOVE_REWARD = 0.00002 ether;
    uint256 public constant COLLISION_PENALTY = 0.0005 ether;
    uint16 public constant FEE_BPS = 100; // 1% service fee — thin on purpose; revenue story is race frequency (agents racing 24/7), not per-race take
    uint16 public constant BPS_DENOM = 10000;
    // First few segments never collision-check — otherwise every public
    // lobby's opening tick is everyone racing for the same 3(now 5) lanes
    // simultaneously with zero room to spread out, wrecking half the field
    // before the race has really started.
    uint16 public constant GRACE_SEGMENTS = 3;
    uint256 public constant LANE_COUNT = 5;

    enum LobbyMode {
        HUMAN_ONLY,
        AGENT_ONLY,
        SHOWCASE_MIXED
    }
    enum SegmentType {
        STRAIGHT,
        TURN,
        OBSTACLE,
        BOOST
    }
    // Widened from 3 to 5 so more racers can be adjacent at once without
    // forcing lane contention just from population density.
    enum Lane {
        FAR_LEFT,
        LEFT,
        CENTER,
        RIGHT,
        FAR_RIGHT
    }
    enum RacePhase {
        LOBBY,
        COMMITTED,
        RUNNING,
        FINISHED
    }

    struct Player {
        address addr;
        uint256 stake;
        uint16 position;
        uint16 lastCheckpoint;
        uint8 hp;
        uint8 speed;
        bool alive; // false only once "broke" (stake == 0)
        bool finished;
    }

    struct Race {
        LobbyMode mode;
        RacePhase phase;
        bytes32 commitHash;
        uint256 seed;
        uint256 entryFee;
        uint256 pot;
        address[] playerAddrs;
        address[] finishOrder;
    }

    address public immutable treasury;

    uint256 public nextRaceId;
    mapping(uint256 => Race) private races;
    mapping(uint256 => mapping(address => Player)) private racePlayers;
    // keccak(segment, lane) -> first address to claim that spot this race
    mapping(uint256 => mapping(bytes32 => address)) private laneClaims;

    event LobbyCreated(uint256 indexed raceId, LobbyMode mode, uint256 entryFee);
    event PlayerJoined(uint256 indexed raceId, address indexed player, uint256 stake);
    event RaceStarted(uint256 indexed raceId, uint256 seed);
    event Moved(uint256 indexed raceId, address indexed player, uint16 fromSegment, uint16 toSegment, Lane lane);
    event Collision(uint256 indexed raceId, address indexed attacker, address indexed target, uint8 damage, uint256 penalty);
    event Wrecked(uint256 indexed raceId, address indexed player, uint16 respawnAt);
    event Eliminated(uint256 indexed raceId, address indexed player);
    event Finished(uint256 indexed raceId, address indexed player, uint256 rank);
    event RaceSettled(uint256 indexed raceId, uint256 fee, uint256 payoutPool);

    constructor(address _treasury) {
        treasury = _treasury;
    }

    // ---- lobby lifecycle ----

    function createLobby(LobbyMode mode, uint256 entryFee) external returns (uint256 raceId) {
        raceId = nextRaceId++;
        Race storage r = races[raceId];
        r.mode = mode;
        r.phase = RacePhase.LOBBY;
        r.entryFee = entryFee;
        emit LobbyCreated(raceId, mode, entryFee);
    }

    function join(uint256 raceId) external payable {
        Race storage r = races[raceId];
        require(r.phase == RacePhase.LOBBY, "not joinable");
        require(msg.value == r.entryFee, "bad entry fee");
        require(racePlayers[raceId][msg.sender].addr == address(0), "already joined");

        racePlayers[raceId][msg.sender] = Player({
            addr: msg.sender,
            stake: msg.value,
            position: 0,
            lastCheckpoint: 0,
            hp: HP_MAX,
            speed: 0,
            alive: true,
            finished: false
        });
        r.playerAddrs.push(msg.sender);
        r.pot += msg.value;
        emit PlayerJoined(raceId, msg.sender, msg.value);
    }

    /// @notice Commit to a hidden seed. Call this when the lobby closes.
    function commitSeed(uint256 raceId, bytes32 commitHash) external {
        Race storage r = races[raceId];
        require(r.phase == RacePhase.LOBBY, "not in lobby");
        require(r.playerAddrs.length > 0, "empty lobby");
        r.commitHash = commitHash;
        r.phase = RacePhase.COMMITTED;
    }

    /// @notice Reveal the seed and start the race. Call as close to go as
    ///         possible (ideally one block) — see PROJECT.md §4.
    function startRace(uint256 raceId, uint256 seed, uint256 salt) external {
        Race storage r = races[raceId];
        require(r.phase == RacePhase.COMMITTED, "not committed");
        require(keccak256(abi.encodePacked(seed, salt)) == r.commitHash, "bad reveal");
        r.seed = seed;
        r.phase = RacePhase.RUNNING;
        emit RaceStarted(raceId, seed);
    }

    // ---- deterministic track generation ----

    function segmentAt(uint256 seed, uint16 i) public pure returns (SegmentType) {
        uint256 h = uint256(keccak256(abi.encodePacked(seed, i)));
        uint256 rmod = h % 100;
        if (rmod < 55) return SegmentType.STRAIGHT;
        if (rmod < 80) return SegmentType.TURN;
        if (rmod < 95) return SegmentType.OBSTACLE;
        return SegmentType.BOOST;
    }

    function correctLaneAt(uint256 seed, uint16 i) public pure returns (Lane) {
        uint256 h = uint256(keccak256(abi.encodePacked(seed, i, "lane")));
        return Lane(h % LANE_COUNT);
    }

    function isCheckpoint(uint16 segmentIndex) public pure returns (bool) {
        return segmentIndex % CHECKPOINT_INTERVAL == 0;
    }

    // ---- the move ----

    function chooseLane(uint256 raceId, Lane lane) external {
        Race storage r = races[raceId];
        require(r.phase == RacePhase.RUNNING, "not running");
        Player storage p = racePlayers[raceId][msg.sender];
        require(p.addr != address(0) && p.alive && !p.finished, "not active");

        uint16 nextSeg = p.position + 1;
        require(nextSeg <= SEGMENTS_TOTAL, "already finished");

        bool inGracePeriod = nextSeg <= GRACE_SEGMENTS;
        bytes32 claimKey = keccak256(abi.encodePacked(nextSeg, lane));

        if (!inGracePeriod) {
            address priorClaimant = laneClaims[raceId][claimKey];
            if (priorClaimant != address(0) && priorClaimant != msg.sender) {
                // Collision: priorClaimant already holds this segment+lane.
                // No stake changes hands here anymore — losing a collision
                // already costs you HP and, on a wreck, your progress back
                // to the last checkpoint. Taking stake too was double
                // punishment and the main way stake kept draining even
                // while playing correctly (wrong-lane misses are the only
                // remaining way to lose stake, and those are now avoidable
                // since the correct lane is shown in the UI).
                Player storage attacker = racePlayers[raceId][priorClaimant];
                uint8 dmg = attacker.speed > 0 ? attacker.speed : 1;
                _applyCollisionDamage(raceId, p, dmg);

                emit Collision(raceId, priorClaimant, msg.sender, dmg, 0);
                return;
            }
            laneClaims[raceId][claimKey] = msg.sender;
        }

        SegmentType segType = segmentAt(r.seed, nextSeg);
        bool wrongLane = false;
        if (segType == SegmentType.TURN || segType == SegmentType.OBSTACLE) {
            wrongLane = (lane != correctLaneAt(r.seed, nextSeg));
        }

        if (wrongLane) {
            uint256 penalty = COLLISION_PENALTY > p.stake ? p.stake : COLLISION_PENALTY;
            p.stake -= penalty;
            r.pot += penalty; // penalties fund the pool that pays MOVE_REWARD below
            p.speed = 0;
            _checkBroke(raceId, p);
            emit Moved(raceId, msg.sender, p.position, p.position, lane);
            return;
        }

        // Correct move: reward, not charge. See MOVE_REWARD comment above.
        uint256 reward = MOVE_REWARD > r.pot ? r.pot : MOVE_REWARD;
        p.stake += reward;
        r.pot -= reward;

        uint16 fromSeg = p.position;
        p.position = nextSeg;
        p.speed = p.speed + 1 > MAX_SPEED ? MAX_SPEED : p.speed + 1;
        if (isCheckpoint(nextSeg)) {
            p.lastCheckpoint = nextSeg;
        }
        emit Moved(raceId, msg.sender, fromSeg, nextSeg, lane);

        if (nextSeg == SEGMENTS_TOTAL) {
            p.finished = true;
            r.finishOrder.push(msg.sender);
            emit Finished(raceId, msg.sender, r.finishOrder.length);
        }
    }

    function _applyCollisionDamage(uint256 raceId, Player storage p, uint8 dmg) internal {
        if (p.hp <= dmg) {
            p.hp = HP_MAX;
            p.position = p.lastCheckpoint;
            p.speed = 0;
            emit Wrecked(raceId, p.addr, p.lastCheckpoint);
        } else {
            p.hp -= dmg;
            p.speed = 0;
        }
    }

    function _checkBroke(uint256 raceId, Player storage p) internal {
        if (p.stake == 0 && p.alive) {
            p.alive = false;
            emit Eliminated(raceId, p.addr);
        }
    }

    // ---- settlement ----

    /// @notice Pays the service fee to treasury and splits the remaining
    ///         pot 50/30/20 across the top 3 finishers. Callable once at
    ///         least one player has finished.
    function settle(uint256 raceId) external {
        Race storage r = races[raceId];
        require(r.phase == RacePhase.RUNNING, "not running");
        require(r.finishOrder.length > 0, "nobody finished");
        r.phase = RacePhase.FINISHED;

        uint256 fee = (r.pot * FEE_BPS) / BPS_DENOM;
        uint256 payoutPool = r.pot - fee;

        (bool feeOk,) = treasury.call{value: fee}("");
        require(feeOk, "fee transfer failed");

        uint16[3] memory splitBps = [uint16(5000), uint16(3000), uint16(2000)];
        uint256 winners = r.finishOrder.length < 3 ? r.finishOrder.length : 3;
        for (uint256 i = 0; i < winners; i++) {
            address winner = r.finishOrder[i];
            uint256 amount = (payoutPool * splitBps[i]) / BPS_DENOM;
            (bool ok,) = winner.call{value: amount}("");
            require(ok, "payout failed");
        }
        emit RaceSettled(raceId, fee, payoutPool);
    }

    // ---- views for the backend / agents (see README "Playing as an AI agent") ----

    function getPlayer(uint256 raceId, address who) external view returns (Player memory) {
        return racePlayers[raceId][who];
    }

    function getPhase(uint256 raceId) external view returns (RacePhase) {
        return races[raceId].phase;
    }

    function getSeed(uint256 raceId) external view returns (uint256) {
        return races[raceId].seed;
    }

    function getPlayers(uint256 raceId) external view returns (address[] memory) {
        return races[raceId].playerAddrs;
    }

    function getPot(uint256 raceId) external view returns (uint256) {
        return races[raceId].pot;
    }

    function getEntryFee(uint256 raceId) external view returns (uint256) {
        return races[raceId].entryFee;
    }

    function getMode(uint256 raceId) external view returns (LobbyMode) {
        return races[raceId].mode;
    }
}
