// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "../src/Monadrift.sol";

contract MonadriftTest is Test {
    Monadrift m;
    address treasury = address(0xFEE);
    address a = address(0xA);
    address b = address(0xB);
    uint256 raceId;
    uint256 seed;
    uint256 constant FEE = 0.01 ether;

    function setUp() public {
        m = new Monadrift(treasury);
        vm.deal(a, 1 ether);
        vm.deal(b, 1 ether);
        raceId = m.createLobby(Monadrift.LobbyMode.AGENT_ONLY, FEE);
        vm.prank(a); m.join{value: FEE}(raceId);
        vm.prank(b); m.join{value: FEE}(raceId);
    }

    function _start(uint256 s) internal {
        seed = s;
        m.commitSeed(raceId, keccak256(abi.encodePacked(s, uint256(1))));
        m.startRace(raceId, s, 1);
    }

    /// Move `who` forward one segment using the lane that is always safe
    /// (correct lane on TURN/OBSTACLE, `free` otherwise).
    function _lane(uint16 seg, Monadrift.Lane free) internal view returns (Monadrift.Lane) {
        Monadrift.SegmentType t = m.segmentAt(seed, seg);
        if (t == Monadrift.SegmentType.TURN || t == Monadrift.SegmentType.OBSTACLE) {
            return m.correctLaneAt(seed, seg);
        }
        return free;
    }

    function _step(address who, Monadrift.Lane free) internal {
        uint16 next = m.getPlayer(raceId, who).position + 1;
        Monadrift.Lane l = _lane(next, free); // compute before prank: view calls consume it
        vm.prank(who);
        m.chooseLane(raceId, l);
    }

    /// Regression: the first racer through a forced lane must not leave a
    /// permanent claim that wrecks every later racer taking the same lane.
    function test_noSoftLockOnForcedLane() public {
        _start(12345);
        // A runs well ahead of B so they are never on the same segment.
        for (uint256 i = 0; i < 25; i++) _step(a, Monadrift.Lane.LEFT);
        for (uint256 i = 0; i < 20; i++) _step(b, Monadrift.Lane.LEFT);
        assertEq(m.getPlayer(raceId, b).position, 20);
        assertEq(m.getPlayer(raceId, b).hp, 3);
    }

    function test_collisionWhenOccupied() public {
        _start(777);
        // Both reach segment 5 on LEFT-compatible lanes, A first.
        for (uint256 i = 0; i < 5; i++) _step(a, Monadrift.Lane.FAR_LEFT);
        for (uint256 i = 0; i < 4; i++) _step(b, Monadrift.Lane.FAR_LEFT);
        uint16 seg = 5;
        Monadrift.Lane aLane = m.getPlayer(raceId, a).lane;
        vm.prank(b);
        m.chooseLane(raceId, aLane); // B moves into A's exact spot
        Monadrift.Player memory pb = m.getPlayer(raceId, b);
        // A has speed 3 >= HP_MAX, so the hit wrecks B back to its checkpoint.
        assertEq(pb.position, 0, "wrecked to checkpoint");
        assertTrue(pb.respawned);
        assertEq(m.getPlayer(raceId, a).position, seg);
    }

    function test_wreckRespawnsAtCheckpointWithoutPhantomOccupant() public {
        _start(2024);
        for (uint256 i = 0; i < 12; i++) _step(a, Monadrift.Lane.FAR_LEFT);
        // Wreck B repeatedly on A's tile until it respawns at checkpoint 0.
        for (uint256 i = 0; i < 11; i++) _step(b, Monadrift.Lane.FAR_LEFT);
        // B at 11, A at 12: B steps onto A.
        Monadrift.Lane aLane = m.getPlayer(raceId, a).lane;
        for (uint256 i = 0; i < 6 && m.getPlayer(raceId, b).position == 11; i++) {
            vm.prank(b);
            m.chooseLane(raceId, aLane);
        }
        Monadrift.Player memory pb = m.getPlayer(raceId, b);
        assertEq(pb.position, 10, "respawned at checkpoint 10");
        assertTrue(pb.respawned);
        // A is far ahead; a third mover entering segment 10 in B's stale lane must not collide.
        // (Re-use A: put it back by checking the occupant filter via B's own flag.)
        Monadrift.Lane l11 = _lane(11, Monadrift.Lane.FAR_LEFT);
        vm.prank(b);
        m.chooseLane(raceId, l11);
        assertFalse(m.getPlayer(raceId, b).respawned, "flag cleared after moving");
    }

    /// Regression: a player parked on a forced-lane (TURN/OBSTACLE) segment,
    /// e.g. out of MON, must not wreck everyone who must take that same lane.
    /// Seed 2, segment 6 is an OBSTACLE (segments 4-5 are STRAIGHT).
    function test_parkedPlayerOnForcedLaneDoesNotBlock() public {
        _start(2);
        for (uint256 i = 0; i < 6; i++) _step(a, Monadrift.Lane.FAR_LEFT); // A parks at 6
        for (uint256 i = 0; i < 5; i++) _step(b, Monadrift.Lane.FAR_LEFT);
        assertEq(m.getPlayer(raceId, a).position, 6);
        _step(b, Monadrift.Lane.FAR_LEFT); // B takes the same forced lane
        Monadrift.Player memory pb = m.getPlayer(raceId, b);
        assertEq(pb.position, 6, "passed through without collision");
        assertEq(pb.hp, 3);
    }
}
