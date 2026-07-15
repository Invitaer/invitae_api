// Mock secrets before any imports to prevent secrets validation at import time
jest.mock('../config/secrets', () => ({
  secrets: {
    REDIS_HOST: 'localhost',
    REDIS_PORT: '6379',
    REDIS_PASSWORD: '',
  },
}));

const mockSet = jest.fn();
const mockQuit = jest.fn();
const mockOn = jest.fn();

jest.mock('ioredis', () => {
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      set: mockSet,
      on: mockOn,
      quit: mockQuit,
    })),
  };
});

import { RedisService } from './redis.service';

describe('RedisService.setNX', () => {
  let service: RedisService;

  beforeEach(() => {
    mockSet.mockReset();
    service = new RedisService();
  });

  it('returns true when the key is absent (SET NX succeeds -> "OK")', async () => {
    mockSet.mockResolvedValue('OK');

    const result = await service.setNX('wa:msg:abc123', 'claimed', 86400);

    expect(mockSet).toHaveBeenCalledWith('wa:msg:abc123', 'claimed', 'EX', 86400, 'NX');
    expect(result).toBe(true);
  });

  it('returns false when the key is already present (SET NX no-op -> null)', async () => {
    mockSet.mockResolvedValue(null);

    const result = await service.setNX('wa:msg:dup456', 'claimed', 86400);

    expect(mockSet).toHaveBeenCalledWith('wa:msg:dup456', 'claimed', 'EX', 86400, 'NX');
    expect(result).toBe(false);
  });
});
