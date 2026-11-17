---
title: Agents, workspaces, and the leader
description: Understand the reusable teammates, the project space they join, and who receives an unaddressed message.
version: 0.1.x
---

# Agents, workspaces, and the leader

An agent is a teammate you keep. A workspace is the project space where that
teammate works with others. The leader is the member who receives a message
that does not name anyone.

## What you see

- **Agents in the rail.** Each agent appears once under its primary workspace.
  The row shows the agent name, the leader marker when it leads, and the role as
  the subline. Agents with no workspace appear under **Homeless**.
- **Workspaces in the rail.** Each workspace row carries its directory label
  and may show unread, busy, or paused markers. Selecting a workspace opens its
  group chat.
- **Agent settings.** Press `s` on an agent to edit its name, title, role,
  models, memories, and Skillbox. Press `e` on a workspace to edit its members
  and leader.
- **Leader marker.** The leader is marked inline in the rail. No permission
  badge distinguishes it, because leadership does not grant extra permissions.
- **Pause.** Press `p` to pause or resume a workspace. A paused workspace
  rejects new work until you resume it.

## Mental model

An **agent** is a lasting profile, not a single conversation. It has a name, a
title, a role, a main model with optional backups, a Skillbox, and memory. Its
identity survives renames, workspace changes, and new conversations. The
**roster** is your personal collection of agents, reusable across projects.

A **workspace** is a directory-bound project space. It has one group chat, a set
of member agents, and exactly one leader. One canonical directory belongs to one
active workspace. The workspace's `.ensemble/config.json` is authoritative for
its name, leader, members, synthesis setting, and pause state. Conversation
history stays in OpenCode storage, not in the repository.

Membership is many-to-many:

- An agent can belong to several workspaces.
- The rail groups it under its **primary workspace**: the active workspace
  first, then the most recently joined membership, then Homeless.
- An agent with no workspace still has a direct chat, so you can work with it
  before it joins a project.

The **leader** is a role, not a rank. It receives every group message that names
no agent, coordinates the response, and can delegate typed work. Any member can
answer a direct chat, receive a `$Name` route, or be made leader. Changing the
leader changes who receives unaddressed messages, not what any agent is allowed
to do.

## Example

The **Acme Notes** workspace has Ada as leader and Grace as a member. You create
a new agent, Linus, and add it to Acme Notes while editing the workspace. Linus
now has a group chat in Acme Notes and a direct chat of its own. The rail shows
Linus under Acme Notes, with its role on the second line.

You send a message with no `$Name`. Ada receives it because Ada is the leader.
If you later make Grace the leader, the next unaddressed message goes to Grace;
both agents keep their existing conversations and work history.

## Next

- [Conversations and routing](conversations-and-routing.md): how a message
  reaches one agent or the whole group.
- [Guides](../guides/README.md): create a workspace, add members, and choose a
  leader.
- [Reference](../reference/README.md): exact keys, configuration fields, and
  storage locations.

## Go deeper

- [ADR 0007: Apply agent behavior changes in place](../adr/0007-apply-agent-behavior-in-place.md)
- [ADR 0009: Conversation identity and sessions](../adr/0009-conversation-identity-and-sessions.md)
- [Implementation notes: workspaces and agents](../implementation.md#workspaces)
