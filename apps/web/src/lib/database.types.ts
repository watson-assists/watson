export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      audio_tracks: {
        Row: {
          consultation_id: string
          created_at: string
          duration_seconds: number | null
          format: string
          id: string
          offset_seconds: number
          sha256: string
          size_bytes: number
          speaker: Database["public"]["Enums"]["speaker"]
          storage_path: string
          validation: Database["public"]["Enums"]["track_validation"]
          validation_error: string | null
        }
        Insert: {
          consultation_id: string
          created_at?: string
          duration_seconds?: number | null
          format: string
          id?: string
          offset_seconds?: number
          sha256: string
          size_bytes: number
          speaker: Database["public"]["Enums"]["speaker"]
          storage_path: string
          validation?: Database["public"]["Enums"]["track_validation"]
          validation_error?: string | null
        }
        Update: {
          consultation_id?: string
          created_at?: string
          duration_seconds?: number | null
          format?: string
          id?: string
          offset_seconds?: number
          sha256?: string
          size_bytes?: number
          speaker?: Database["public"]["Enums"]["speaker"]
          storage_path?: string
          validation?: Database["public"]["Enums"]["track_validation"]
          validation_error?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audio_tracks_consultation_id_fkey"
            columns: ["consultation_id"]
            isOneToOne: false
            referencedRelation: "consultations"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_events: {
        Row: {
          actor_id: string
          actor_role: string
          consultation_id: string
          event_hash: string
          event_id: string
          event_type: string
          metadata_without_clinical_content: Json
          previous_event_hash: string | null
          resource_id: string | null
          resource_type: string
          result: string
          seq: number
          timestamp_utc: string
        }
        Insert: {
          actor_id: string
          actor_role: string
          consultation_id: string
          event_hash: string
          event_id: string
          event_type: string
          metadata_without_clinical_content?: Json
          previous_event_hash?: string | null
          resource_id?: string | null
          resource_type: string
          result: string
          seq?: never
          timestamp_utc: string
        }
        Update: {
          actor_id?: string
          actor_role?: string
          consultation_id?: string
          event_hash?: string
          event_id?: string
          event_type?: string
          metadata_without_clinical_content?: Json
          previous_event_hash?: string | null
          resource_id?: string | null
          resource_type?: string
          result?: string
          seq?: never
          timestamp_utc?: string
        }
        Relationships: [
          {
            foreignKeyName: "audit_events_consultation_id_fkey"
            columns: ["consultation_id"]
            isOneToOne: false
            referencedRelation: "consultations"
            referencedColumns: ["id"]
          },
        ]
      }
      busy_times: {
        Row: {
          ends_at: string
          practitioner_id: string
          starts_at: string
        }
        Insert: {
          ends_at: string
          practitioner_id: string
          starts_at: string
        }
        Update: {
          ends_at?: string
          practitioner_id?: string
          starts_at?: string
        }
        Relationships: []
      }
      consultations: {
        Row: {
          booked_at: string | null
          consent_recorded_at: string | null
          consent_recorded_by: string | null
          consent_withdrawn_at: string | null
          consent_withdrawn_by: string | null
          created_at: string
          duration_minutes: number
          fee_cents: number | null
          google_event_id: string | null
          hold_until: string | null
          id: string
          invite_token: string
          language: Database["public"]["Enums"]["consultation_language"]
          legacy_patient_id: string | null
          paid_amount_cents: number | null
          paid_at: string | null
          patient_associated_at: string | null
          patient_associated_by: string | null
          patient_association_state: string
          patient_claim_email: string | null
          patient_claim_name: string | null
          patient_claim_phone: string | null
          patient_claim_updated_at: string | null
          patient_id: string | null
          practitioner_id: string
          recorded_together: boolean
          remind_whatsapp: boolean
          reminder_sent_at: string | null
          scenario_notes: string
          scheduled_at: string
          short_code: string
          status: Database["public"]["Enums"]["consultation_status"]
          stripe_checkout_session_id: string | null
          synthetic_patient_ref: string
          updated_at: string
          whatsapp_code: string
        }
        Insert: {
          booked_at?: string | null
          consent_recorded_at?: string | null
          consent_recorded_by?: string | null
          consent_withdrawn_at?: string | null
          consent_withdrawn_by?: string | null
          created_at?: string
          duration_minutes?: number
          fee_cents?: number | null
          google_event_id?: string | null
          hold_until?: string | null
          id?: string
          invite_token?: string
          language: Database["public"]["Enums"]["consultation_language"]
          legacy_patient_id?: string | null
          paid_amount_cents?: number | null
          paid_at?: string | null
          patient_associated_at?: string | null
          patient_associated_by?: string | null
          patient_association_state?: string
          patient_claim_email?: string | null
          patient_claim_name?: string | null
          patient_claim_phone?: string | null
          patient_claim_updated_at?: string | null
          patient_id?: string | null
          practitioner_id: string
          recorded_together?: boolean
          remind_whatsapp?: boolean
          reminder_sent_at?: string | null
          scenario_notes?: string
          scheduled_at: string
          short_code?: string
          status: Database["public"]["Enums"]["consultation_status"]
          stripe_checkout_session_id?: string | null
          synthetic_patient_ref: string
          updated_at?: string
          whatsapp_code?: string
        }
        Update: {
          booked_at?: string | null
          consent_recorded_at?: string | null
          consent_recorded_by?: string | null
          consent_withdrawn_at?: string | null
          consent_withdrawn_by?: string | null
          created_at?: string
          duration_minutes?: number
          fee_cents?: number | null
          google_event_id?: string | null
          hold_until?: string | null
          id?: string
          invite_token?: string
          language?: Database["public"]["Enums"]["consultation_language"]
          legacy_patient_id?: string | null
          paid_amount_cents?: number | null
          paid_at?: string | null
          patient_associated_at?: string | null
          patient_associated_by?: string | null
          patient_association_state?: string
          patient_claim_email?: string | null
          patient_claim_name?: string | null
          patient_claim_phone?: string | null
          patient_claim_updated_at?: string | null
          patient_id?: string | null
          practitioner_id?: string
          recorded_together?: boolean
          remind_whatsapp?: boolean
          reminder_sent_at?: string | null
          scenario_notes?: string
          scheduled_at?: string
          short_code?: string
          status?: Database["public"]["Enums"]["consultation_status"]
          stripe_checkout_session_id?: string | null
          synthetic_patient_ref?: string
          updated_at?: string
          whatsapp_code?: string
        }
        Relationships: [
          {
            foreignKeyName: "consultations_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
        ]
      }
      engine_runs: {
        Row: {
          engine_user_id: string
          finished_at: string | null
          id: string
          started_at: string
        }
        Insert: {
          engine_user_id: string
          finished_at?: string | null
          id?: string
          started_at?: string
        }
        Update: {
          engine_user_id?: string
          finished_at?: string | null
          id?: string
          started_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "engine_runs_engine_user_id_fkey"
            columns: ["engine_user_id"]
            isOneToOne: false
            referencedRelation: "engines"
            referencedColumns: ["user_id"]
          },
        ]
      }
      engines: {
        Row: {
          label: string
          last_seen_at: string | null
          on_demand: boolean
          user_id: string
        }
        Insert: {
          label: string
          last_seen_at?: string | null
          on_demand?: boolean
          user_id: string
        }
        Update: {
          label?: string
          last_seen_at?: string | null
          on_demand?: boolean
          user_id?: string
        }
        Relationships: []
      }
      form_answers: {
        Row: {
          document_quotes: Json
          evidence: number[]
          field_key: string
          form_id: string
          machine_text: string | null
          position: number
          practitioner_text: string | null
          review: string
        }
        Insert: {
          document_quotes?: Json
          evidence?: number[]
          field_key: string
          form_id: string
          machine_text?: string | null
          position: number
          practitioner_text?: string | null
          review?: string
        }
        Update: {
          document_quotes?: Json
          evidence?: number[]
          field_key?: string
          form_id?: string
          machine_text?: string | null
          position?: number
          practitioner_text?: string | null
          review?: string
        }
        Relationships: [
          {
            foreignKeyName: "form_answers_form_id_fkey"
            columns: ["form_id"]
            isOneToOne: false
            referencedRelation: "forms"
            referencedColumns: ["id"]
          },
        ]
      }
      form_jobs: {
        Row: {
          attempt: number
          claimed_at: string | null
          consultation_id: string
          engine_user_id: string | null
          error_category: string | null
          finished_at: string | null
          heartbeat_at: string | null
          id: string
          metrics: Json
          queued_at: string
          status: Database["public"]["Enums"]["job_status"]
          transcript_id: string
        }
        Insert: {
          attempt?: number
          claimed_at?: string | null
          consultation_id: string
          engine_user_id?: string | null
          error_category?: string | null
          finished_at?: string | null
          heartbeat_at?: string | null
          id?: string
          metrics?: Json
          queued_at?: string
          status?: Database["public"]["Enums"]["job_status"]
          transcript_id: string
        }
        Update: {
          attempt?: number
          claimed_at?: string | null
          consultation_id?: string
          engine_user_id?: string | null
          error_category?: string | null
          finished_at?: string | null
          heartbeat_at?: string | null
          id?: string
          metrics?: Json
          queued_at?: string
          status?: Database["public"]["Enums"]["job_status"]
          transcript_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "form_jobs_consultation_id_fkey"
            columns: ["consultation_id"]
            isOneToOne: false
            referencedRelation: "consultations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "form_jobs_transcript_id_fkey"
            columns: ["transcript_id"]
            isOneToOne: false
            referencedRelation: "transcripts"
            referencedColumns: ["id"]
          },
        ]
      }
      form_templates: {
        Row: {
          definition: Json
          practitioner_id: string
          updated_at: string
        }
        Insert: {
          definition: Json
          practitioner_id: string
          updated_at?: string
        }
        Update: {
          definition?: Json
          practitioner_id?: string
          updated_at?: string
        }
        Relationships: []
      }
      forms: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          consultation_id: string
          created_at: string
          id: string
          job_id: string
          status: string
          template: Json
          transcript_id: string
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          consultation_id: string
          created_at?: string
          id?: string
          job_id: string
          status?: string
          template: Json
          transcript_id: string
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          consultation_id?: string
          created_at?: string
          id?: string
          job_id?: string
          status?: string
          template?: Json
          transcript_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "forms_consultation_id_fkey"
            columns: ["consultation_id"]
            isOneToOne: false
            referencedRelation: "consultations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "forms_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: true
            referencedRelation: "form_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "forms_transcript_id_fkey"
            columns: ["transcript_id"]
            isOneToOne: false
            referencedRelation: "transcripts"
            referencedColumns: ["id"]
          },
        ]
      }
      google_calendars: {
        Row: {
          calendar_id: string
          checked_at: string | null
          connected_at: string
          email: string
          practitioner_id: string
          problem: string | null
          refresh_token: string
        }
        Insert: {
          calendar_id: string
          checked_at?: string | null
          connected_at?: string
          email: string
          practitioner_id: string
          problem?: string | null
          refresh_token: string
        }
        Update: {
          calendar_id?: string
          checked_at?: string | null
          connected_at?: string
          email?: string
          practitioner_id?: string
          problem?: string | null
          refresh_token?: string
        }
        Relationships: []
      }
      live_pieces: {
        Row: {
          claimed_at: string | null
          consultation_id: string
          corrected_at: string | null
          created_at: string
          engine_user_id: string | null
          heard_text: string | null
          id: string
          offset_seconds: number
          seq: number
          speaker: Database["public"]["Enums"]["speaker"]
          status: string
          storage_path: string
          text: string | null
        }
        Insert: {
          claimed_at?: string | null
          consultation_id: string
          corrected_at?: string | null
          created_at?: string
          engine_user_id?: string | null
          heard_text?: string | null
          id?: string
          offset_seconds: number
          seq: number
          speaker: Database["public"]["Enums"]["speaker"]
          status?: string
          storage_path: string
          text?: string | null
        }
        Update: {
          claimed_at?: string | null
          consultation_id?: string
          corrected_at?: string | null
          created_at?: string
          engine_user_id?: string | null
          heard_text?: string | null
          id?: string
          offset_seconds?: number
          seq?: number
          speaker?: Database["public"]["Enums"]["speaker"]
          status?: string
          storage_path?: string
          text?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "live_pieces_consultation_id_fkey"
            columns: ["consultation_id"]
            isOneToOne: false
            referencedRelation: "consultations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "live_pieces_engine_user_id_fkey"
            columns: ["engine_user_id"]
            isOneToOne: false
            referencedRelation: "engines"
            referencedColumns: ["user_id"]
          },
        ]
      }
      patient_documents: {
        Row: {
          claimed_at: string | null
          cleanup_completed_at: string | null
          consultation_id: string
          created_at: string
          engine_user_id: string | null
          error_category: string | null
          file_name: string
          id: string
          legacy_patient_id: string | null
          media_type: string
          page_texts: string[] | null
          patient_id: string | null
          practitioner_id: string
          read_at: string | null
          reading: Database["public"]["Enums"]["document_reading"]
          reading_attempt: number
          removed_at: string | null
          size_bytes: number
          source: string
          storage_path: string
          uploaded_at: string | null
        }
        Insert: {
          claimed_at?: string | null
          cleanup_completed_at?: string | null
          consultation_id: string
          created_at?: string
          engine_user_id?: string | null
          error_category?: string | null
          file_name: string
          id?: string
          legacy_patient_id?: string | null
          media_type: string
          page_texts?: string[] | null
          patient_id?: string | null
          practitioner_id: string
          read_at?: string | null
          reading?: Database["public"]["Enums"]["document_reading"]
          reading_attempt?: number
          removed_at?: string | null
          size_bytes: number
          source: string
          storage_path: string
          uploaded_at?: string | null
        }
        Update: {
          claimed_at?: string | null
          cleanup_completed_at?: string | null
          consultation_id?: string
          created_at?: string
          engine_user_id?: string | null
          error_category?: string | null
          file_name?: string
          id?: string
          legacy_patient_id?: string | null
          media_type?: string
          page_texts?: string[] | null
          patient_id?: string | null
          practitioner_id?: string
          read_at?: string | null
          reading?: Database["public"]["Enums"]["document_reading"]
          reading_attempt?: number
          removed_at?: string | null
          size_bytes?: number
          source?: string
          storage_path?: string
          uploaded_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "patient_documents_consultation_id_fkey"
            columns: ["consultation_id"]
            isOneToOne: false
            referencedRelation: "consultations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patient_documents_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
        ]
      }
      patients: {
        Row: {
          created_at: string
          email: string | null
          id: string
          name: string
          phone: string | null
          practitioner_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          email?: string | null
          id?: string
          name: string
          phone?: string | null
          practitioner_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          email?: string | null
          id?: string
          name?: string
          phone?: string | null
          practitioner_id?: string
          updated_at?: string
        }
        Relationships: []
      }
      practitioner_profiles: {
        Row: {
          about: string
          display_name: string
          fee_cents: number | null
          gap_minutes: number
          hours: Json
          languages: Database["public"]["Enums"]["consultation_language"][]
          length_minutes: number
          offer: string
          practitioner_id: string
          slug: string
          time_zone: string
          updated_at: string
        }
        Insert: {
          about?: string
          display_name: string
          fee_cents?: number | null
          gap_minutes?: number
          hours?: Json
          languages?: Database["public"]["Enums"]["consultation_language"][]
          length_minutes?: number
          offer?: string
          practitioner_id: string
          slug: string
          time_zone?: string
          updated_at?: string
        }
        Update: {
          about?: string
          display_name?: string
          fee_cents?: number | null
          gap_minutes?: number
          hours?: Json
          languages?: Database["public"]["Enums"]["consultation_language"][]
          length_minutes?: number
          offer?: string
          practitioner_id?: string
          slug?: string
          time_zone?: string
          updated_at?: string
        }
        Relationships: []
      }
      spellings: {
        Row: {
          consultation_id: string
          created_at: string
          heard: string
          id: string
          patient_id: string | null
          practitioner_id: string
          written: string
        }
        Insert: {
          consultation_id: string
          created_at?: string
          heard: string
          id?: string
          patient_id?: string | null
          practitioner_id: string
          written: string
        }
        Update: {
          consultation_id?: string
          created_at?: string
          heard?: string
          id?: string
          patient_id?: string | null
          practitioner_id?: string
          written?: string
        }
        Relationships: [
          {
            foreignKeyName: "spellings_consultation_id_fkey"
            columns: ["consultation_id"]
            isOneToOne: false
            referencedRelation: "consultations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "spellings_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
        ]
      }
      transcript_segments: {
        Row: {
          confidence: number | null
          end_seconds: number
          id: string
          machine_text: string
          overlap: boolean | null
          position: number
          possibly_not_speech: boolean
          review_status: string
          reviewed_text: string | null
          speaker: Database["public"]["Enums"]["speaker"]
          start_seconds: number
          transcript_id: string
        }
        Insert: {
          confidence?: number | null
          end_seconds: number
          id: string
          machine_text: string
          overlap?: boolean | null
          position: number
          possibly_not_speech?: boolean
          review_status?: string
          reviewed_text?: string | null
          speaker: Database["public"]["Enums"]["speaker"]
          start_seconds: number
          transcript_id: string
        }
        Update: {
          confidence?: number | null
          end_seconds?: number
          id?: string
          machine_text?: string
          overlap?: boolean | null
          position?: number
          possibly_not_speech?: boolean
          review_status?: string
          reviewed_text?: string | null
          speaker?: Database["public"]["Enums"]["speaker"]
          start_seconds?: number
          transcript_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "transcript_segments_transcript_id_fkey"
            columns: ["transcript_id"]
            isOneToOne: false
            referencedRelation: "transcripts"
            referencedColumns: ["id"]
          },
        ]
      }
      transcription_jobs: {
        Row: {
          attempt: number
          claimed_at: string | null
          consultation_id: string
          engine_user_id: string | null
          error_category: string | null
          failed_speaker: Database["public"]["Enums"]["speaker"] | null
          finished_at: string | null
          heartbeat_at: string | null
          id: string
          metrics: Json
          queued_at: string
          requested_by: string
          stage: Database["public"]["Enums"]["job_stage"] | null
          status: Database["public"]["Enums"]["job_status"]
        }
        Insert: {
          attempt?: number
          claimed_at?: string | null
          consultation_id: string
          engine_user_id?: string | null
          error_category?: string | null
          failed_speaker?: Database["public"]["Enums"]["speaker"] | null
          finished_at?: string | null
          heartbeat_at?: string | null
          id?: string
          metrics?: Json
          queued_at?: string
          requested_by: string
          stage?: Database["public"]["Enums"]["job_stage"] | null
          status?: Database["public"]["Enums"]["job_status"]
        }
        Update: {
          attempt?: number
          claimed_at?: string | null
          consultation_id?: string
          engine_user_id?: string | null
          error_category?: string | null
          failed_speaker?: Database["public"]["Enums"]["speaker"] | null
          finished_at?: string | null
          heartbeat_at?: string | null
          id?: string
          metrics?: Json
          queued_at?: string
          requested_by?: string
          stage?: Database["public"]["Enums"]["job_stage"] | null
          status?: Database["public"]["Enums"]["job_status"]
        }
        Relationships: [
          {
            foreignKeyName: "transcription_jobs_consultation_id_fkey"
            columns: ["consultation_id"]
            isOneToOne: false
            referencedRelation: "consultations"
            referencedColumns: ["id"]
          },
        ]
      }
      transcripts: {
        Row: {
          consultation_id: string
          created_at: string
          id: string
          job_id: string
          low_confidence_threshold: number
          ordering: Database["public"]["Enums"]["transcript_ordering"]
          review_status: Database["public"]["Enums"]["transcript_review_status"]
          reviewed_at: string | null
          reviewed_by: string | null
          schema_version: string
          tracks: Json
        }
        Insert: {
          consultation_id: string
          created_at?: string
          id?: string
          job_id: string
          low_confidence_threshold: number
          ordering: Database["public"]["Enums"]["transcript_ordering"]
          review_status?: Database["public"]["Enums"]["transcript_review_status"]
          reviewed_at?: string | null
          reviewed_by?: string | null
          schema_version: string
          tracks: Json
        }
        Update: {
          consultation_id?: string
          created_at?: string
          id?: string
          job_id?: string
          low_confidence_threshold?: number
          ordering?: Database["public"]["Enums"]["transcript_ordering"]
          review_status?: Database["public"]["Enums"]["transcript_review_status"]
          reviewed_at?: string | null
          reviewed_by?: string | null
          schema_version?: string
          tracks?: Json
        }
        Relationships: [
          {
            foreignKeyName: "transcripts_consultation_id_fkey"
            columns: ["consultation_id"]
            isOneToOne: false
            referencedRelation: "consultations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transcripts_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: true
            referencedRelation: "transcription_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_contacts: {
        Row: {
          consultation_id: string
          last_inbound_at: string | null
          linked_at: string
          phone: string
          profile_name: string | null
        }
        Insert: {
          consultation_id: string
          last_inbound_at?: string | null
          linked_at?: string
          phone: string
          profile_name?: string | null
        }
        Update: {
          consultation_id?: string
          last_inbound_at?: string | null
          linked_at?: string
          phone?: string
          profile_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_contacts_consultation_id_fkey"
            columns: ["consultation_id"]
            isOneToOne: false
            referencedRelation: "consultations"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_messages: {
        Row: {
          body: string | null
          consultation_id: string | null
          created_at: string
          direction: string
          error: string | null
          id: string
          kind: string
          phone: string
          status: string
          wa_message_id: string | null
        }
        Insert: {
          body?: string | null
          consultation_id?: string | null
          created_at?: string
          direction: string
          error?: string | null
          id?: string
          kind: string
          phone: string
          status: string
          wa_message_id?: string | null
        }
        Update: {
          body?: string | null
          consultation_id?: string | null
          created_at?: string
          direction?: string
          error?: string | null
          id?: string
          kind?: string
          phone?: string
          status?: string
          wa_message_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_messages_consultation_id_fkey"
            columns: ["consultation_id"]
            isOneToOne: false
            referencedRelation: "consultations"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      add_document: {
        Args: {
          p_consultation_id: string
          p_file_name: string
          p_media_type: string
          p_size_bytes: number
        }
        Returns: Json
      }
      add_live_piece: {
        Args: {
          p_consultation_id: string
          p_offset_seconds: number
          p_seq: number
          p_speaker: Database["public"]["Enums"]["speaker"]
        }
        Returns: Json
      }
      approve_form: { Args: { p_form_id: string }; Returns: Json }
      archive_consultation: {
        Args: { p_consultation_id: string }
        Returns: Json
      }
      book_time: {
        Args: {
          p_contact: string
          p_language: Database["public"]["Enums"]["consultation_language"]
          p_name: string
          p_remind_whatsapp: boolean
          p_slug: string
          p_starts_at: string
        }
        Returns: Json
      }
      booking_times: {
        Args: { p_from: string; p_slug: string; p_to: string }
        Returns: Json
      }
      bootstrap_patient_role: { Args: never; Returns: Json }
      calendar_week: { Args: { p_from: string; p_to: string }; Returns: Json }
      cancel_patient_otp_challenge: {
        Args: { p_code_hash: string; p_contact_hash: string }
        Returns: Json
      }
      cancel_transcription: {
        Args: { p_consultation_id: string }
        Returns: Json
      }
      complete_document_cleanup: {
        Args: { p_document_id: string }
        Returns: boolean
      }
      confirm_audio_deleted: {
        Args: { p_consultation_id: string }
        Returns: Json
      }
      confirm_document: { Args: { p_document_id: string }; Returns: Json }
      confirm_new_patient: {
        Args: { p_consultation_id: string }
        Returns: Json
      }
      correct_live_line: {
        Args: { p_piece_id: string; p_spellings?: Json; p_text: string }
        Returns: Json
      }
      correct_transcript_line: {
        Args: { p_segment_id: string; p_spellings?: Json; p_text: string }
        Returns: Json
      }
      create_consultation: {
        Args: {
          p_consent_recorded: boolean
          p_fee_cents?: number
          p_language: Database["public"]["Enums"]["consultation_language"]
          p_patient_contact?: string
          p_patient_name?: string
          p_scenario_notes?: string
          p_scheduled_at: string
          p_synthetic_patient_ref?: string
        }
        Returns: Json
      }
      current_user_roles: { Args: never; Returns: string[] }
      declare_recorded_together: {
        Args: { p_consultation_id: string; p_recorded_together: boolean }
        Returns: Json
      }
      engine_claim_document: { Args: never; Returns: Json }
      engine_claim_form_job: { Args: never; Returns: Json }
      engine_claim_job: { Args: never; Returns: Json }
      engine_claim_live_piece: { Args: never; Returns: Json }
      engine_complete_document: {
        Args: { p_attempt: number; p_document_id: string; p_pages: string[] }
        Returns: Json
      }
      engine_complete_form_job: {
        Args: {
          p_answers: Json
          p_attempt: number
          p_job_id: string
          p_metrics?: Json
        }
        Returns: Json
      }
      engine_complete_job: {
        Args: {
          p_attempt: number
          p_job_id: string
          p_metrics?: Json
          p_transcript: Json
        }
        Returns: Json
      }
      engine_fail_document: {
        Args: {
          p_attempt: number
          p_document_id: string
          p_error_category: string
        }
        Returns: Json
      }
      engine_fail_form_job: {
        Args: { p_attempt: number; p_error_category: string; p_job_id: string }
        Returns: Json
      }
      engine_fail_job: {
        Args: {
          p_attempt: number
          p_error_category: string
          p_job_id: string
          p_metrics?: Json
          p_speaker?: Database["public"]["Enums"]["speaker"]
        }
        Returns: Json
      }
      engine_form_heartbeat: {
        Args: { p_attempt: number; p_job_id: string }
        Returns: Json
      }
      engine_heartbeat: {
        Args: {
          p_attempt: number
          p_audio_seconds?: number
          p_job_id: string
          p_stage: Database["public"]["Enums"]["job_stage"]
        }
        Returns: Json
      }
      engine_hints: { Args: { p_consultation_id: string }; Returns: Json }
      engine_live_piece_done: {
        Args: { p_id: string; p_text: string }
        Returns: Json
      }
      engine_live_piece_failed: { Args: { p_id: string }; Returns: Json }
      engine_run_finished: { Args: { p_run_id: string }; Returns: Json }
      engine_run_started: { Args: never; Returns: Json }
      engine_status: { Args: never; Returns: Json }
      fill_form_again: { Args: { p_consultation_id: string }; Returns: Json }
      find_practitioners: { Args: never; Returns: Json }
      google_disconnect: { Args: { p_practitioner: string }; Returns: Json }
      google_event_written: {
        Args: { p_consultation: string; p_event_id: string }
        Returns: Json
      }
      google_events_due: { Args: { p_practitioner: string }; Returns: Json }
      google_problem: {
        Args: { p_practitioner: string; p_problem: string }
        Returns: Json
      }
      google_replace_busy: {
        Args: { p_busy: Json; p_practitioner: string }
        Returns: Json
      }
      google_save_connection: {
        Args: {
          p_calendar_id: string
          p_email: string
          p_practitioner: string
          p_refresh_token: string
        }
        Returns: Json
      }
      invite_details: { Args: { p_token: string }; Returns: Json }
      issue_patient_otp_challenge: {
        Args: { p_code_hash: string; p_contact_hash: string; p_ip_hash: string }
        Returns: Json
      }
      make_consultation_free: {
        Args: { p_consultation_id: string }
        Returns: Json
      }
      open_short_link: { Args: { p_code: string }; Returns: Json }
      patient_add_document: {
        Args: {
          p_file_name: string
          p_media_type: string
          p_size_bytes: number
          p_token: string
        }
        Returns: Json
      }
      patient_confirm_document: {
        Args: { p_document_id: string; p_token: string }
        Returns: Json
      }
      patient_identify: {
        Args: { p_contact: string; p_name: string; p_token: string }
        Returns: Json
      }
      patient_link_consultation: { Args: { p_token: string }; Returns: Json }
      patient_remove_document: {
        Args: { p_document_id: string; p_token: string }
        Returns: Json
      }
      patient_review_association: {
        Args: {
          p_consultation_id: string
          p_decision: string
          p_patient_id: string
        }
        Returns: Json
      }
      provision_patient_role_after_otp: {
        Args: { p_user_id: string }
        Returns: Json
      }
      read_document_again: { Args: { p_document_id: string }; Returns: Json }
      record_consent: { Args: { p_consultation_id: string }; Returns: Json }
      record_payment: {
        Args: {
          p_amount_cents: number
          p_consultation_id: string
          p_session_id: string
        }
        Returns: Json
      }
      register_audio_track: {
        Args: {
          p_consultation_id: string
          p_duration_seconds?: number
          p_format: string
          p_sha256: string
          p_size_bytes: number
          p_speaker: Database["public"]["Enums"]["speaker"]
        }
        Returns: Json
      }
      register_engine: {
        Args: { p_label: string; p_user_id: string }
        Returns: undefined
      }
      register_patient_otp_session: {
        Args: {
          p_session_id: string
          p_user_id: string
          p_verified_email: string
          p_verified_phone: string
        }
        Returns: Json
      }
      register_practitioner: { Args: { p_user_id: string }; Returns: undefined }
      released: {
        Args: {
          p_consultation: Database["public"]["Tables"]["consultations"]["Row"]
        }
        Returns: boolean
      }
      remove_audio_track: {
        Args: {
          p_consultation_id: string
          p_speaker: Database["public"]["Enums"]["speaker"]
        }
        Returns: Json
      }
      remove_document: { Args: { p_document_id: string }; Returns: Json }
      renew_hold: { Args: { p_token: string }; Returns: Json }
      review_form_answer: {
        Args: {
          p_decision: string
          p_field_key: string
          p_form_id: string
          p_text?: string
        }
        Returns: Json
      }
      save_booking_page: {
        Args: {
          p_about: string
          p_display_name: string
          p_fee_cents: number
          p_gap_minutes: number
          p_hours: Json
          p_languages: Database["public"]["Enums"]["consultation_language"][]
          p_length_minutes: number
          p_offer: string
        }
        Returns: Json
      }
      set_form_template: { Args: { p_definition: Json }; Returns: Json }
      set_patient: {
        Args: { p_consultation_id: string; p_contact: string; p_name: string }
        Returns: Json
      }
      start_form: { Args: { p_consultation_id: string }; Returns: Json }
      start_transcription: {
        Args: { p_consultation_id: string }
        Returns: Json
      }
      use_watson_form: { Args: never; Returns: Json }
      verify_audit_chain: {
        Args: { p_consultation_id: string }
        Returns: boolean
      }
      verify_patient_otp_challenge: {
        Args: { p_code_hash: string; p_contact_hash: string; p_ip_hash: string }
        Returns: Json
      }
      watson_whatsapp: { Args: { p_token: string }; Returns: Json }
      whatsapp_add_document: {
        Args: {
          p_file_name: string
          p_media_type: string
          p_phone: string
          p_size_bytes: number
        }
        Returns: Json
      }
      whatsapp_confirm_document: {
        Args: { p_document_id: string }
        Returns: Json
      }
      whatsapp_due_reminders: { Args: never; Returns: Json }
      whatsapp_gateway_contacts: { Args: never; Returns: Json }
      whatsapp_gateway_seen: { Args: { p_status: string }; Returns: Json }
      whatsapp_gateway_state_read: { Args: never; Returns: Json }
      whatsapp_gateway_state_write: { Args: { p_changes: Json }; Returns: Json }
      whatsapp_gateway_unreachable: { Args: never; Returns: Json }
      whatsapp_receive: {
        Args: {
          p_body: string
          p_kind: string
          p_phone: string
          p_profile_name: string
          p_wa_message_id: string
        }
        Returns: Json
      }
      whatsapp_reminder_sent: {
        Args: { p_consultation: string }
        Returns: Json
      }
      whatsapp_sent: {
        Args: {
          p_body: string
          p_consultation_id: string
          p_error?: string
          p_phone: string
          p_wa_message_id: string
        }
        Returns: Json
      }
      whatsapp_status: {
        Args: { p_error?: string; p_status: string; p_wa_message_id: string }
        Returns: Json
      }
      withdraw_consent: { Args: { p_consultation_id: string }; Returns: Json }
    }
    Enums: {
      consultation_language: "en" | "de" | "sk" | "auto"
      consultation_status:
        | "consent_pending"
        | "ready_for_audio"
        | "audio_imported"
        | "transcription_processing"
        | "transcription_failed"
        | "transcript_ready"
        | "transcript_under_review"
        | "transcript_reviewed"
        | "extraction_processing"
        | "extraction_failed"
        | "draft_ready"
        | "under_review"
        | "approved"
        | "corrected"
        | "consent_withdrawn"
        | "archived"
      document_reading: "waiting" | "reading" | "read" | "unreadable" | "failed"
      job_stage:
        | "validating"
        | "transcribing_practitioner"
        | "transcribing_patient"
        | "merging"
      job_status: "queued" | "processing" | "completed" | "failed" | "cancelled"
      speaker: "practitioner" | "patient"
      track_validation: "pending" | "valid" | "invalid"
      transcript_ordering: "exact" | "approximate"
      transcript_review_status:
        | "unreviewed"
        | "under_review"
        | "reviewed"
        | "superseded"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      consultation_language: ["en", "de", "sk", "auto"],
      consultation_status: [
        "consent_pending",
        "ready_for_audio",
        "audio_imported",
        "transcription_processing",
        "transcription_failed",
        "transcript_ready",
        "transcript_under_review",
        "transcript_reviewed",
        "extraction_processing",
        "extraction_failed",
        "draft_ready",
        "under_review",
        "approved",
        "corrected",
        "consent_withdrawn",
        "archived",
      ],
      document_reading: ["waiting", "reading", "read", "unreadable", "failed"],
      job_stage: [
        "validating",
        "transcribing_practitioner",
        "transcribing_patient",
        "merging",
      ],
      job_status: ["queued", "processing", "completed", "failed", "cancelled"],
      speaker: ["practitioner", "patient"],
      track_validation: ["pending", "valid", "invalid"],
      transcript_ordering: ["exact", "approximate"],
      transcript_review_status: [
        "unreviewed",
        "under_review",
        "reviewed",
        "superseded",
      ],
    },
  },
} as const
