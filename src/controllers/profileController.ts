import type { NextFunction, Request, Response } from 'express';
import * as db from '../config/db.js';

/**
 * GET /api/profile (protected)
 * Returns the authenticated user's details.
 */
export async function getProfile(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void | Response> {
  try {
    const { rows } = await db.query(
      `SELECT id, username, email, created_at, updated_at
       FROM users WHERE id = $1`,
      [req.user!.id]
    );

    if (!rows[0]) {
      return res.status(404).json({ error: 'User not found' });
    }
    return res.json({ user: rows[0] });
  } catch (err) {
    return next(err);
  }
}
