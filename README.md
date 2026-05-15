# invitae_api
API centalizada para el manejo de contenido en las invitaciones y administracion de invitados.

## Funcionalidades
- Administracion de Contenido para invitaciones con rick text 

  - Administrado en una base de datos Redis que sera consumida por el frontend (Astros) para los  invitados
  
- Administracion de invitados,
  - Creacion, actualizacion y edicion de usuarios
  - asignacio de mesa para los usuarios
  s
- Notificacion a los usuarios:
  - Via whatsapp (principal y requerida)
  - Via SMS
  - Via email (no importante)

## Infraestructura

Una API REST con 2 endpoint principales.

# `/admin`
Perimite exponer los endpoints a los administradores para el manejo de usuarios, asi como el contenido de de la invitacion.

# `/invitae`
Expone los datos hacia la invitacion, solo tiene 1 metodo `POST` que permite al Invitado confirmar asistencia.
