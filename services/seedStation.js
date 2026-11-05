import bcrypt from 'bcryptjs';
import User from '../model/UserSchema.js';

// Insert-only: never reset credentials, reactivate, or promote an existing account.
export async function seedStation({ settings, logger, UserModel = User }) {
  if (!settings.stationSeed) return null;
  if (settings.nodeEnv !== 'development') {
    throw new Error('Coast Guard development seeding is disabled in this environment');
  }
  const { email, password, contact } = settings.stationSeed;
  const assertStation = (user) => {
    if (user.role !== 'coastguard' || !user.isActive) {
      throw new Error('Station seed conflicts with an existing account; manual review required');
    }
    return user;
  };
  const existing = await UserModel.findOne({ email });
  if (existing) return assertStation(existing);
  try {
    const station = await UserModel.create({
      username: `coastguard:${email}`,
      firstName: 'Coast Guard',
      lastName: 'Station',
      email,
      contact,
      password: await bcrypt.hash(password, 12),
      role: 'coastguard',
      isActive: true,
    });
    // Password is supplied by the operator's ignored .env; never log it.
    logger?.info('coastguard.station_seeded');
    return station;
  } catch (error) {
    if (error.code !== 11000) throw error;
    const winner = await UserModel.findOne({ email });
    if (!winner) throw error;
    return assertStation(winner);
  }
}
