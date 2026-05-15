import { SetMetadata, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { secrets } from '../../config/secrets';

export const IS_PUBLIC_KEY = secrets.IS_PUBLIC_KEY;
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export function Auth() {
  return UseGuards(AuthGuard('jwt'));
}