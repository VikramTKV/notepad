// Site settings. Fill in supabaseUrl and supabaseAnonKey from your Supabase
// "notepad" project: Dashboard -> Project Settings -> API.
//
// The anon (public) key is meant to be in browser code; Row Level Security in
// supabase/schema.sql is what protects the data. NEVER put the service_role key here.
window.QUILLNOTE_CONFIG = {
  brandName: "Quillnote",
  tagline: "write it down, share it by link",
  supabaseUrl: "https://wdlazljrsocquyqaivmq.supabase.co", // Supabase project "notepad"
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndkbGF6bGpyc29jcXV5cWFpdm1xIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIwMDAzNTIsImV4cCI6MjEwNzU3NjM1Mn0.gnWmL6Dclnv7lhYhOnLUEo7rUj2JrFphLuQUJ8BfFfc",
  aiEnabled: false,      // set true after deploying the "ask" Edge Function
  googleSignIn: false,   // set true after enabling Google under Authentication -> Providers
  contactEmail: "",      // shown on shared notes so readers can report abuse
};
