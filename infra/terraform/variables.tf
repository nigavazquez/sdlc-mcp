variable "project" {
  description = "Prefijo de todos los recursos del stack."
  type        = string
  default     = "sdlc-mcp"
}

variable "env" {
  description = "Entorno. Hoy hay uno solo; la variable existe para que el naming no haya que rehacerlo si aparece un segundo."
  type        = string
  default     = "prod"
}

variable "region" {
  description = "Región de AWS."
  type        = string
  default     = "us-east-1"
}

variable "domain" {
  description = "Host público del server (el de PUBLIC_URL). El registro DNS apunta acá y Caddy saca el certificado para este nombre."
  type        = string
}

variable "vpc_id" {
  description = "VPC donde va la instancia. null = la VPC default de la cuenta."
  type        = string
  default     = null
}

variable "subnet_id" {
  description = "Subnet pública donde va la instancia. null = la primera subnet de la VPC elegida."
  type        = string
  default     = null
}

variable "instance_type" {
  description = "Tipo de instancia. El server y Postgres conviven: con menos de 4 GB el OOM killer aparece en el primer pico."
  type        = string
  default     = "t3.medium"
}

variable "root_volume_gb" {
  description = "Disco raíz. Acá viven el volumen de Postgres, las imágenes y los logs."
  type        = number
  default     = 30
}

variable "ssh_key_name" {
  description = "Key pair para SSH. null = sin SSH; el acceso es por SSM Session Manager, que es el camino recomendado."
  type        = string
  default     = null
}

variable "ssh_allowed_cidrs" {
  description = "CIDRs que pueden abrir el 22. Vacío (el default) = el security group no abre SSH a nadie."
  type        = list(string)
  default     = []
}

variable "secret_name_prefix" {
  description = "Prefijo de los secretos que la instancia puede leer. Todo lo del deploy vive bajo este prefijo."
  type        = string
  default     = "sdlc/"
}

variable "image_retention_count" {
  description = "Cuántas imágenes conserva ECR. Un rollback necesita tener a mano la anterior, no sólo la última."
  type        = number
  default     = 20
}
