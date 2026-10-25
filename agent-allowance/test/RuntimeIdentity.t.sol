// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AgentAllowance, IERC20} from "../src/AgentAllowance.sol";
import {MockUSDC, Asserts, vm} from "./Support.sol";

interface RuntimeVm {
    function etch(address target, bytes calldata code) external;
}

/// Reproduces why off-chain identity checks must not blindly mask immutables.
/// This is a forged runtime installed in a local test, NOT a way to modify an
/// existing immutable deployment. An attacker would need a separate deployment
/// and would need to persuade the owner to approve that forged contract.
contract RuntimeIdentityTest is Asserts {
    function test_forged_runtime_can_keep_the_agent_getter_but_accept_another_key() public {
        address owner = address(0xB001);
        address agent = address(0xA001);
        address attacker = address(0xBAD1);
        MockUSDC token = new MockUSDC();
        token.mint(owner, 1_000_000);
        AgentAllowance limiter = new AgentAllowance(
            IERC20(address(token)), owner, agent, address(0xC001),
            1_000_000, 500_000, block.timestamp + 1 days
        );
        vm.prank(owner);
        token.approve(address(limiter), 1_000_000);

        bytes memory original = address(limiter).code;
        bytes32 originalWord = bytes32(uint256(uint160(agent)));
        bytes32 changedWord = bytes32(uint256(uint160(attacker)));
        for (uint256 i; i + 32 <= original.length; ++i) {
            bytes32 word;
            assembly { word := mload(add(add(original, 32), i)) }
            if (word != originalWord) continue;
            bytes memory changed = abi.encodePacked(original);
            assembly { mstore(add(add(changed, 32), i), changedWord) }
            RuntimeVm(address(vm)).etch(address(limiter), changed);
            if (limiter.agent() == agent) {
                vm.prank(attacker);
                (bool paid,) = address(limiter).call(abi.encodeCall(
                    AgentAllowance.spend, (attacker, 500_000, bytes32(uint256(1)))
                ));
                if (paid) {
                    assertEq(token.balanceOf(attacker), 500_000, "forged execution key spent");
                    assertEq(uint256(uint160(limiter.agent())), uint256(uint160(agent)), "getter still honest");
                    return;
                }
            }
            RuntimeVm(address(vm)).etch(address(limiter), original);
        }
        revert("expected separate getter and execution copies of agent");
    }
}
