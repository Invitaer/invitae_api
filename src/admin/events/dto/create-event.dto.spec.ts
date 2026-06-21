import { validate } from 'class-validator';
import { CreateEventDto, EVENT_TYPES } from './create-event.dto';

function buildDto(overrides: Partial<CreateEventDto> = {}): CreateEventDto {
  const dto = new CreateEventDto();
  dto.name = 'My Wedding';
  dto.slug = 'my-wedding-2025';
  dto.date = '2025-10-10';
  dto.eventType = 'wedding';
  Object.assign(dto, overrides);
  return dto;
}

describe('CreateEventDto — validation', () => {
  describe('eventType field', () => {
    it('should fail validation when eventType is missing', async () => {
      const dto = buildDto({ eventType: undefined as any });
      const errors = await validate(dto);
      const eventTypeErrors = errors.filter((e) => e.property === 'eventType');
      expect(eventTypeErrors.length).toBeGreaterThan(0);
    });

    it('should pass validation when eventType is a valid value', async () => {
      const dto = buildDto({ eventType: 'wedding' });
      const errors = await validate(dto);
      const eventTypeErrors = errors.filter((e) => e.property === 'eventType');
      expect(eventTypeErrors).toHaveLength(0);
    });

    it('should fail validation when eventType is not in the allowed list', async () => {
      const dto = buildDto({ eventType: 'invalid_type' });
      const errors = await validate(dto);
      const eventTypeErrors = errors.filter((e) => e.property === 'eventType');
      expect(eventTypeErrors.length).toBeGreaterThan(0);
    });

    it('should pass validation for all valid EVENT_TYPES values', async () => {
      for (const type of EVENT_TYPES) {
        const dto = buildDto({ eventType: type });
        const errors = await validate(dto);
        const eventTypeErrors = errors.filter((e) => e.property === 'eventType');
        expect(eventTypeErrors).toHaveLength(0);
      }
    });
  });

  describe('location field', () => {
    it('should pass validation when location is absent (optional)', async () => {
      const dto = buildDto();
      delete (dto as any).location;
      const errors = await validate(dto);
      const locationErrors = errors.filter((e) => e.property === 'location');
      expect(locationErrors).toHaveLength(0);
    });

    it('should pass validation when location is provided', async () => {
      const dto = buildDto({ location: 'Buenos Aires' });
      const errors = await validate(dto);
      const locationErrors = errors.filter((e) => e.property === 'location');
      expect(locationErrors).toHaveLength(0);
    });
  });
});
