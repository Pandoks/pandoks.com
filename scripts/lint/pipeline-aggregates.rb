require "yaml"

pipeline = ".github/workflows/pipeline.yaml"
jobs = YAML.safe_load_file(pipeline, aliases: true, permitted_classes: [Date, Time]).fetch("jobs")
aggregates = jobs.select { |name, _| name.end_with?("-pass") }
github = File.read("infra/github.ts").gsub(%r{//[^\n]*|/\*.*?\*/}m, "")
required = github[/requiredChecks: \[(.*?)\]/m, 1].scan(/'(.*?)'/).flatten
failed = "${{ contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled') }}"
gate = {
  "if" => "${{ always() }}",
  "runs-on" => "ubuntu-latest",
  "steps" => [{ "if" => failed, "run" => "exit 1" }]
}

abort "changes must run unconditionally" if jobs.fetch("changes").key?("if")

missing = required - aggregates.keys
abort "requiredChecks with no pipeline job: #{missing.join(', ')}" unless missing.empty?

aggregates.each do |name, job|
  abort "#{name} must directly need changes" unless Array(job["needs"]).include?("changes")
  abort "#{name} must be `needs` plus exactly:\n#{gate.to_yaml}" unless job.except("needs") == gate
end

covered = aggregates.values_at(*required).flat_map { |job| Array(job["needs"]) }
orphans = jobs.keys - aggregates.keys - covered
abort "Jobs no required aggregate needs: #{orphans.join(', ')}" unless orphans.empty?
