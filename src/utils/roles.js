'use strict';

// The three project roles, in increasing authority.
//
//   viewer — read the project, list its files, search its knowledge
//   editor — everything a viewer can do, and write knowledge, upload and
//            delete files, and change the project's title and description
//   admin  — everything an editor can do, plus member management and
//            embedding model configuration
//
// A member role of null or absent means the user is not a member at all, and
// ranks zero here. The owner is never expressed as a role: `documents.owner_id`
// is the authority, and every check below takes the ownership flag alongside
// the role so the two can never be confused.
//
// This lives here because the web path and the MCP path must agree. The same
// question was previously answered independently in three controllers and in
// the MCP guard, and a change to one did not reach the others.

const ROLE_RANK = { viewer: 1, editor: 2, admin: 3 };

// The roles that may be granted to a member, in ascending authority.
const MEMBER_ROLES = ['viewer', 'editor', 'admin'];

/**
 * Rank a member role. An absent or unrecognised role ranks zero.
 * @param {string|null|undefined} role
 * @returns {number}
 */
function rank(role) {
  return ROLE_RANK[role] || 0;
}

/**
 * May this user write knowledge, files, or project text?
 * True for the owner, and for members with the 'editor' or 'admin' role.
 * @param {boolean} isOwner
 * @param {string|null} memberRole
 * @returns {boolean}
 */
function canWrite(isOwner, memberRole) {
  return Boolean(isOwner) || rank(memberRole) >= ROLE_RANK.editor;
}

/**
 * May this user administer the project — manage members, or change the
 * embedding model? True for the owner and members with the 'admin' role.
 *
 * Deliberately stricter than canWrite. Handing role management to an editor
 * would let an editor promote themselves, so administration stays with the
 * owner and admins.
 * @param {boolean} isOwner
 * @param {string|null} memberRole
 * @returns {boolean}
 */
function canAdminister(isOwner, memberRole) {
  return Boolean(isOwner) || rank(memberRole) >= ROLE_RANK.admin;
}

/**
 * Is this a role that may be granted to a member at all?
 * @param {string} role
 * @returns {boolean}
 */
function isMemberRole(role) {
  return MEMBER_ROLES.includes(role);
}

module.exports = { MEMBER_ROLES, rank, canWrite, canAdminister, isMemberRole };
