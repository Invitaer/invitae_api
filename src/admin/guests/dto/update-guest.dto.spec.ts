import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateGuestDto } from './update-guest.dto';

async function validateDto(payload: Record<string, unknown>) {
  const dto = plainToInstance(UpdateGuestDto, payload);
  const errors = await validate(dto);
  return { dto, errors };
}

describe('UpdateGuestDto — email optionality', () => {
  it('accepts an empty-string email (blank field) as if omitted', async () => {
    const { dto, errors } = await validateDto({ name: 'Ada', email: '' });

    expect(errors).toHaveLength(0);
    // "" is normalized to null so the column is cleared, not stored as "".
    expect(dto.email).toBeNull();
  });

  it('accepts an omitted email', async () => {
    const { errors } = await validateDto({ name: 'Ada' });

    expect(errors).toHaveLength(0);
  });

  it('still rejects a non-empty, malformed email', async () => {
    const { errors } = await validateDto({ email: 'not-an-email' });

    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('email');
  });

  it('accepts a valid email', async () => {
    const { dto, errors } = await validateDto({ email: 'ada@example.com' });

    expect(errors).toHaveLength(0);
    expect(dto.email).toBe('ada@example.com');
  });
});
