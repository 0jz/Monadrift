// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "../src/MonadriftRT.sol";

contract Reenter {
    MonadriftRT rt;
    uint256 public hits;
    constructor(MonadriftRT _rt) { rt = _rt; }
    function enter(uint256 raceId) external payable { rt.join{value: msg.value}(raceId, address(this)); }
    function pull() external { rt.claim(); }
    receive() external payable { hits++; if (hits < 3) { try rt.claim() {} catch {} } }
}

contract Rejector { receive() external payable { revert("no"); } }

contract MonadriftRTTest is Test {
    MonadriftRT rt;
    address op = address(this);
    address treasury = address(0xFEE);
    address[4] p = [address(0xA1), address(0xA2), address(0xA3), address(0xA4)];
    uint256 constant FEE = 1 ether;
    uint256 constant SEED = 777;
    uint256 constant SALT = 42;
    bytes32 commit = keccak256(abi.encodePacked(SEED, SALT));
    uint256 id;

    function setUp() public {
        rt = new MonadriftRT(treasury, op);
        for (uint256 i; i < 4; i++) vm.deal(p[i], 10 ether);
        id = rt.createRace(MonadriftRT.Mode.AGENT_ONLY, FEE, 4);
    }

    function _join(uint256 n) internal {
        for (uint256 i; i < n; i++) { vm.prank(p[i]); rt.join{value: FEE}(id, p[i]); }
    }
    function _run(uint256 n) internal { _join(n); rt.commitSeed(id, commit); }
    function _w(uint256 n) internal view returns (address[] memory w) {
        w = new address[](n);
        for (uint256 i; i < n; i++) w[i] = p[i];
    }

    // ---- lobby ----
    function test_joinRules() public {
        vm.prank(p[0]); vm.expectRevert("wrong entry fee"); rt.join{value: FEE - 1}(id, p[0]);
        vm.prank(p[0]); rt.join{value: FEE}(id, p[0]);
        vm.prank(p[0]); vm.expectRevert("already joined"); rt.join{value: FEE}(id, p[0]);
        vm.prank(p[1]); vm.expectRevert("zero payout"); rt.join{value: FEE}(id, address(0));
        _join(0);
        for (uint256 i = 1; i < 4; i++) { vm.prank(p[i]); rt.join{value: FEE}(id, p[i]); }
        vm.deal(address(0x99), FEE);
        vm.prank(address(0x99)); vm.expectRevert("race full"); rt.join{value: FEE}(id, address(0x99));
    }

    function test_onlyOperator() public {
        _join(2);
        vm.startPrank(p[0]);
        vm.expectRevert("operator only"); rt.commitSeed(id, commit);
        vm.expectRevert("operator only"); rt.createRace(MonadriftRT.Mode.HUMAN_ONLY, FEE, 4);
        vm.stopPrank();
        rt.commitSeed(id, commit);
        vm.prank(p[0]); vm.expectRevert("operator only"); rt.checkpoint(id, 0, bytes32(uint256(1)));
        vm.prank(p[0]); vm.expectRevert("operator only"); rt.settle(id, SEED, SALT, _w(1), 0);
    }

    function test_commitNeedsPlayersAndClosesLobby() public {
        _join(1);
        vm.expectRevert("need more players"); rt.commitSeed(id, commit);
        vm.prank(p[1]); rt.join{value: FEE}(id, p[1]);
        rt.commitSeed(id, commit);
        vm.prank(p[2]); vm.expectRevert("lobby closed"); rt.join{value: FEE}(id, p[2]);
    }

    function test_maxPlayersBounds() public {
        vm.expectRevert("bad maxPlayers"); rt.createRace(MonadriftRT.Mode.HUMAN_ONLY, FEE, 1);
        vm.expectRevert("bad maxPlayers"); rt.createRace(MonadriftRT.Mode.HUMAN_ONLY, FEE, 13);
    }

    // ---- checkpoints ----
    function test_checkpointEventOnly() public {
        _run(2);
        vm.expectEmit(true, false, false, true);
        emit MonadriftRT.Checkpoint(id, 3, bytes32(uint256(0xabc)));
        rt.checkpoint(id, 3, bytes32(uint256(0xabc)));
    }

    function test_checkpointOnlyWhileRunning() public {
        _join(2);
        vm.expectRevert("not running"); rt.checkpoint(id, 0, 0);
    }

    // ---- settle ----
    function _claimAll() internal returns (uint256[4] memory got, uint256 tre) {
        for (uint256 i; i < 4; i++) {
            if (rt.owed(p[i]) == 0) continue;
            uint256 b = p[i].balance;
            vm.prank(p[i]); rt.claim();
            got[i] = p[i].balance - b;
        }
        if (rt.owed(treasury) > 0) { vm.prank(treasury); rt.claim(); tre = treasury.balance; }
    }

    function test_settleThreeWinners() public {
        _run(4); // pot 4 ether, fee 0.04, prize 3.96
        rt.settle(id, SEED, SALT, _w(3), keccak256("replay"));
        (uint256[4] memory got, uint256 tre) = _claimAll();
        assertEq(tre, 0.04 ether);
        assertEq(got[0], 1.98 ether);
        assertEq(got[1], 1.188 ether);
        assertEq(got[2], 0.792 ether);
        assertEq(got[0] + got[1] + got[2] + tre, 4 ether);
    }

    function test_settleTwoWinnersRenormalised() public {
        _run(4);
        rt.settle(id, SEED, SALT, _w(2), 0);
        (uint256[4] memory got, uint256 tre) = _claimAll();
        assertEq(got[0], 2.475 ether); // 62.5% of 3.96
        assertEq(got[1], 1.485 ether); // 37.5%
        assertEq(got[0] + got[1] + tre, 4 ether);
    }

    function test_settleOneWinnerTakesAll() public {
        _run(2);
        rt.settle(id, SEED, SALT, _w(1), 0);
        (uint256[4] memory got, uint256 tre) = _claimAll();
        assertEq(tre, 0.02 ether);
        assertEq(got[0], 1.98 ether);
    }

    function test_settleZeroWinnersRefundsEveryoneNoFee() public {
        _run(3);
        rt.settle(id, SEED, SALT, new address[](0), 0);
        (uint256[4] memory got, uint256 tre) = _claimAll();
        assertEq(tre, 0);
        assertEq(got[0], FEE); assertEq(got[1], FEE); assertEq(got[2], FEE);
    }

    function testFuzz_noWeiStranded(uint96 fee, uint8 nw) public {
        nw = uint8(bound(nw, 1, 3));
        uint256 f = bound(fee, 1, 5 ether);
        uint256 rid = rt.createRace(MonadriftRT.Mode.HUMAN_ONLY, f, 4);
        for (uint256 i; i < 4; i++) { vm.deal(p[i], f); vm.prank(p[i]); rt.join{value: f}(rid, p[i]); }
        rt.commitSeed(rid, commit);
        rt.settle(rid, SEED, SALT, _w(nw), 0);
        uint256 sum = rt.owed(treasury);
        for (uint256 i; i < 4; i++) sum += rt.owed(p[i]);
        assertEq(sum, 4 * f);
    }

    function test_settleRejects() public {
        _run(3);
        vm.expectRevert("reveal mismatch"); rt.settle(id, SEED, SALT + 1, _w(1), 0);
        vm.expectRevert("max 3 winners"); rt.settle(id, SEED, SALT, _w(4), 0);
        address[] memory dup = new address[](2); dup[0] = p[0]; dup[1] = p[0];
        vm.expectRevert("duplicate winner"); rt.settle(id, SEED, SALT, dup, 0);
        address[] memory out = new address[](1); out[0] = address(0xBAD);
        vm.expectRevert("winner not in race"); rt.settle(id, SEED, SALT, out, 0);
        rt.settle(id, SEED, SALT, _w(1), 0);
        vm.expectRevert("not running"); rt.settle(id, SEED, SALT, _w(1), 0); // no double settle
    }

    function test_payoutGoesToPayoutAddress() public {
        address cold = address(0xC01D);
        vm.prank(p[0]); rt.join{value: FEE}(id, cold);
        vm.prank(p[1]); rt.join{value: FEE}(id, p[1]);
        rt.commitSeed(id, commit);
        rt.settle(id, SEED, SALT, _w(1), 0);
        assertEq(rt.owed(cold), 1.98 ether);
        assertEq(rt.owed(p[0]), 0);
    }

    function test_rejectingPayoutCannotBlockSettle() public {
        Rejector bad = new Rejector();
        vm.prank(p[0]); rt.join{value: FEE}(id, address(bad));
        vm.prank(p[1]); rt.join{value: FEE}(id, p[1]);
        rt.commitSeed(id, commit);
        rt.settle(id, SEED, SALT, _w(2), 0); // succeeds; only the bad address's own claim fails
        vm.prank(address(bad)); vm.expectRevert("transfer failed"); rt.claim();
        assertEq(rt.owed(address(bad)), 1.2375 ether); // 62.5% of the 1.98 prize: still credited, nothing lost
    }

    // ---- cancel ----
    function test_cancelLobbyAfterTimeout() public {
        _join(2);
        vm.prank(p[0]); vm.expectRevert("too early"); rt.cancel(id);
        vm.warp(block.timestamp + 1 hours);
        vm.prank(p[0]); rt.cancel(id);
        assertEq(rt.owed(p[0]), FEE); assertEq(rt.owed(p[1]), FEE);
        vm.expectRevert("not running"); rt.checkpoint(id, 0, 0);
    }

    function test_cancelRunningAfterResultTimeout() public {
        _run(2);
        vm.warp(block.timestamp + 9 minutes);
        vm.prank(p[0]); vm.expectRevert("too early"); rt.cancel(id);
        vm.warp(block.timestamp + 1 minutes);
        vm.prank(p[1]); rt.cancel(id);
        assertEq(rt.owed(p[0]) + rt.owed(p[1]), 2 * FEE);
        vm.expectRevert("not running"); rt.settle(id, SEED, SALT, _w(1), 0);
    }

    function test_operatorCanCancelAnytimeButNotAfterSettle() public {
        _run(2);
        rt.cancel(id);
        assertEq(rt.owed(p[0]), FEE);
        uint256 id2 = rt.createRace(MonadriftRT.Mode.AGENT_ONLY, FEE, 4);
        vm.prank(p[0]); rt.join{value: FEE}(id2, p[0]);
        vm.prank(p[1]); rt.join{value: FEE}(id2, p[1]);
        rt.commitSeed(id2, commit);
        rt.settle(id2, SEED, SALT, _w(1), 0);
        vm.expectRevert("already ended"); rt.cancel(id2);
    }

    // ---- claim ----
    function test_claimReentrancy() public {
        Reenter r = new Reenter(rt);
        r.enter{value: FEE}(id);
        vm.prank(p[1]); rt.join{value: FEE}(id, p[1]);
        rt.commitSeed(id, commit);
        address[] memory w = new address[](1); w[0] = address(r);
        rt.settle(id, SEED, SALT, w, 0);
        r.pull();
        assertEq(address(r).balance, 1.98 ether); // paid once, re-entry got nothing
        assertEq(address(rt).balance, 2 ether - 1.98 ether); // only the treasury's fee left
    }

    /// Gas measurement for the backend's per-call limits: the worst cases (12 players).
    function test_gasWorstCases() public {
        uint256 rid = rt.createRace(MonadriftRT.Mode.AGENT_ONLY, FEE, 12);
        for (uint256 i; i < 12; i++) {
            address a = address(uint160(0x1000 + i));
            vm.deal(a, FEE);
            vm.prank(a); rt.join{value: FEE}(rid, a);
        }
        rt.commitSeed(rid, commit);
        uint256 g = gasleft();
        rt.cancel(rid);
        emit log_named_uint("cancel, 12 players", g - gasleft());
        uint256 rid2 = rt.createRace(MonadriftRT.Mode.AGENT_ONLY, FEE, 12);
        for (uint256 i; i < 12; i++) {
            address a = address(uint160(0x2000 + i));
            vm.deal(a, FEE);
            vm.prank(a); rt.join{value: FEE}(rid2, a);
        }
        rt.commitSeed(rid2, commit);
        address[] memory w = new address[](3);
        for (uint256 i; i < 3; i++) w[i] = address(uint160(0x2000 + i));
        g = gasleft();
        rt.settle(rid2, SEED, SALT, w, keccak256("r"));
        emit log_named_uint("settle, 3 winners (cold)", g - gasleft());
    }

    function test_claimNothing() public {
        vm.prank(p[0]); vm.expectRevert("nothing to claim"); rt.claim();
    }

    function test_noSuchRace() public {
        vm.expectRevert("no such race"); rt.getPlayers(99);
    }
}
